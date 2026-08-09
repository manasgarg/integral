import type { Connection } from "./connections.ts";
import { IntegralError } from "./errors.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SESSION_PROTOCOL_VERSION = "2025-11-25";
export const MCP_LEGACY_PROTOCOL_VERSION = "2024-11-05";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface McpToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface McpCatalog {
  connection: Connection;
  protocolVersion: string;
  tools: McpTool[];
  diagnostics?: string[];
}

export interface McpRuntime {
  readonly connection: Connection;
  start(): Promise<McpCatalog>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult>;
  stop(): Promise<void>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface RemoteRequestResult {
  response: JsonRpcResponse;
  sessionId?: string;
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IntegralError(`MCP ${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseJsonRpc(text: string): JsonRpcResponse {
  const candidates = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  const raw = candidates.at(-1) ?? text.trim();
  try {
    return record(JSON.parse(raw), "response");
  } catch {
    throw new IntegralError("MCP server returned invalid JSON-RPC");
  }
}

async function jsonDocument<T>(
  url: string,
  request: typeof fetch,
  label: string,
): Promise<T> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
  )
    throw new IntegralError(
      `${label} must use HTTPS unless it targets loopback`,
    );
  const response = await request(parsed, {
    headers: { accept: "application/json" },
    redirect: "manual",
  });
  if (!response.ok)
    throw new IntegralError(
      `${label} discovery failed: HTTP ${response.status}`,
    );
  try {
    return (await response.json()) as T;
  } catch {
    throw new IntegralError(`${label} returned invalid JSON`);
  }
}

function metadataUrl(issuer: string): string {
  const url = new URL(issuer),
    suffix = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `/.well-known/oauth-authorization-server${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function discoverMcpAuthorization(
  connection: Connection,
  request: typeof fetch = fetch,
): Promise<Connection | undefined> {
  if (!connection.url || connection.transport === "stdio") return undefined;
  const id = crypto.randomUUID(),
    probe = await request(connection.url, {
      method: "POST",
      headers: requestHeaders(
        connection,
        undefined,
        MCP_PROTOCOL_VERSION,
        "server/discover",
        undefined,
        undefined,
      ),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "server/discover",
        params: {},
      }),
      redirect: "manual",
    });
  if (probe.ok) return undefined;
  if (probe.status !== 401)
    throw new IntegralError(`MCP discovery failed: HTTP ${probe.status}`);
  const challenge = probe.headers.get("www-authenticate") ?? "",
    advertised = challenge.match(/resource_metadata=(?:"([^"]+)"|([^,\s]+))/i),
    endpoint = new URL(connection.url),
    candidates = [
      advertised?.[1] ?? advertised?.[2],
      new URL(
        `/.well-known/oauth-protected-resource${endpoint.pathname === "/" ? "" : endpoint.pathname}`,
        endpoint.origin,
      ).toString(),
      new URL(
        "/.well-known/oauth-protected-resource",
        endpoint.origin,
      ).toString(),
    ].filter((value): value is string => Boolean(value));
  let protectedMetadata: ProtectedResourceMetadata | undefined,
    protectedError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      protectedMetadata = await jsonDocument<ProtectedResourceMetadata>(
        candidate,
        request,
        "MCP protected-resource metadata",
      );
      break;
    } catch (error) {
      protectedError = error;
    }
  }
  if (!protectedMetadata)
    throw protectedError instanceof Error
      ? protectedError
      : new IntegralError("MCP protected-resource metadata was not found");
  const issuer = protectedMetadata.authorization_servers?.[0];
  if (!issuer)
    throw new IntegralError(
      "MCP protected-resource metadata omitted authorization_servers",
    );
  const authorization = await jsonDocument<AuthorizationServerMetadata>(
    metadataUrl(issuer),
    request,
    "MCP authorization-server metadata",
  );
  if (
    authorization.issuer !== issuer ||
    !authorization.authorization_endpoint ||
    !authorization.token_endpoint
  )
    throw new IntegralError(
      "MCP authorization-server metadata is inconsistent",
    );
  if (!connection.clientId && !authorization.registration_endpoint)
    throw new IntegralError(
      "MCP authorization server requires configured client information",
    );
  return {
    ...connection,
    auth: "oauth",
    authorizationUrl: authorization.authorization_endpoint,
    tokenUrl: authorization.token_endpoint,
    ...(authorization.registration_endpoint
      ? { registrationUrl: authorization.registration_endpoint }
      : {}),
    scopes:
      protectedMetadata.scopes_supported ??
      authorization.scopes_supported ??
      [],
    oauthIssuer: issuer,
    oauthResource: protectedMetadata.resource ?? connection.url,
  };
}

function requestHeaders(
  connection: Connection,
  credential: string | undefined,
  protocolVersion: string,
  method: string,
  name: string | undefined,
  sessionId: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
    "mcp-method": method,
  };
  if (name) headers["mcp-name"] = name;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (connection.auth !== "none" && credential)
    headers[connection.header ?? "Authorization"] =
      `${connection.scheme ?? "Bearer"} ${credential}`.trim();
  return headers;
}

async function postRemote(
  connection: Connection,
  credential: string | undefined,
  protocolVersion: string,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  request: typeof fetch,
  signal?: AbortSignal,
): Promise<RemoteRequestResult> {
  const id = crypto.randomUUID(),
    name = typeof params.name === "string" ? params.name : undefined,
    payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "integral",
            version: "0.1.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    response = await request(connection.url!, {
      method: "POST",
      headers: requestHeaders(
        connection,
        credential,
        protocolVersion,
        method,
        name,
        sessionId,
      ),
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
      redirect: "manual",
    });
  if (response.status >= 300 && response.status < 400)
    throw new IntegralError(
      "MCP server redirected outside its connection boundary",
    );
  if (!response.ok)
    throw new IntegralError(`MCP request failed: HTTP ${response.status}`);
  const parsed = parseJsonRpc(await response.text());
  if (parsed.id !== id)
    throw new IntegralError("MCP response ID did not match its request");
  return {
    response: parsed,
    ...((response.headers.get("mcp-session-id") ?? sessionId)
      ? {
          sessionId: (response.headers.get("mcp-session-id") ?? sessionId)!,
        }
      : {}),
  };
}

function rpcResult(
  value: JsonRpcResponse,
  method: string,
): Record<string, unknown> {
  if (value.error)
    throw new IntegralError(
      `MCP ${method} failed: ${value.error.message ?? value.error.code ?? "unknown error"}`,
    );
  return record(value.result, `${method} result`);
}

export function toolsFromListResult(result: Record<string, unknown>): {
  tools: McpTool[];
  nextCursor?: string;
  diagnostics: string[];
} {
  if (!Array.isArray(result.tools))
    throw new IntegralError("MCP tools/list result omitted tools");
  const tools: McpTool[] = [],
    diagnostics: string[] = [],
    names = new Set<string>(),
    duplicates = new Set<string>();
  for (const raw of result.tools) {
    let name = "unknown";
    try {
      const tool = record(raw, "tool");
      if (typeof tool.name !== "string" || !tool.name)
        throw new IntegralError("MCP tool name must be non-empty");
      name = tool.name;
      if (duplicates.has(name))
        throw new IntegralError("MCP tool name is duplicated");
      if (names.has(name)) {
        tools.splice(
          tools.findIndex((candidate) => candidate.name === name),
          1,
        );
        duplicates.add(name);
        throw new IntegralError("MCP tool name is duplicated");
      }
      const inputSchema = record(tool.inputSchema, "tool inputSchema");
      if (inputSchema.type !== "object")
        throw new IntegralError("MCP tool inputSchema must have object root");
      if (JSON.stringify(inputSchema).length > 100_000)
        throw new IntegralError("MCP tool inputSchema exceeds 100000 bytes");
      names.add(name);
      tools.push({
        name,
        inputSchema,
        ...(typeof tool.title === "string" ? { title: tool.title } : {}),
        ...(typeof tool.description === "string"
          ? { description: tool.description }
          : {}),
        ...(tool.outputSchema !== undefined
          ? { outputSchema: tool.outputSchema }
          : {}),
        ...(tool.annotations && typeof tool.annotations === "object"
          ? { annotations: tool.annotations as Record<string, unknown> }
          : {}),
      });
    } catch (error) {
      diagnostics.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          500,
        ),
      );
    }
  }
  return {
    tools,
    diagnostics,
    ...(typeof result.nextCursor === "string"
      ? { nextCursor: result.nextCursor }
      : {}),
  };
}

class LegacySseTransport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private buffer = "";
  private endpoint: string | undefined;
  private readonly controller = new AbortController();

  constructor(
    private readonly connection: Connection,
    private readonly credential: string | undefined,
    private readonly request: typeof fetch,
  ) {}

  async connect(): Promise<void> {
    if (this.reader) return;
    const response = await this.request(this.connection.url!, {
      headers: requestHeaders(
        this.connection,
        this.credential,
        MCP_LEGACY_PROTOCOL_VERSION,
        "sse/connect",
        undefined,
        undefined,
      ),
      signal: this.controller.signal,
      redirect: "manual",
    });
    if (!response.ok || !response.body)
      throw new IntegralError(
        `MCP legacy SSE connection failed: HTTP ${response.status}`,
      );
    this.reader = response.body.getReader();
    while (!this.endpoint) {
      const event = await this.nextEvent();
      if (event.event !== "endpoint") continue;
      const endpoint = new URL(event.data, this.connection.url);
      if (endpoint.origin !== new URL(this.connection.url!).origin)
        throw new IntegralError("MCP SSE endpoint crossed its origin boundary");
      this.endpoint = endpoint.toString();
    }
  }

  private async nextEvent(): Promise<{ event?: string; data: string }> {
    while (true) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary >= 0) {
        const block = this.buffer.slice(0, boundary),
          separator = this.buffer.slice(boundary).match(/^\r?\n\r?\n/)![0];
        this.buffer = this.buffer.slice(boundary + separator.length);
        const event = block.match(/^event:\s*(.+)$/m)?.[1],
          data = [...block.matchAll(/^data:\s?(.*)$/gm)]
            .map((match) => match[1])
            .join("\n");
        if (data) return { ...(event ? { event } : {}), data };
      }
      const part = await this.reader!.read();
      if (part.done)
        throw new IntegralError("MCP legacy SSE stream ended unexpectedly");
      this.buffer += new TextDecoder().decode(part.value, { stream: true });
    }
  }

  async send(
    method: string,
    params: Record<string, unknown>,
    notification = false,
  ): Promise<JsonRpcResponse | undefined> {
    await this.connect();
    const id = notification ? undefined : crypto.randomUUID(),
      payload = {
        jsonrpc: "2.0",
        ...(id ? { id } : {}),
        method,
        params,
      },
      response = await this.request(this.endpoint!, {
        method: "POST",
        headers: requestHeaders(
          this.connection,
          this.credential,
          MCP_LEGACY_PROTOCOL_VERSION,
          method,
          typeof params.name === "string" ? params.name : undefined,
          undefined,
        ),
        body: JSON.stringify(payload),
        redirect: "manual",
      });
    if (!response.ok)
      throw new IntegralError(`MCP ${method} failed: HTTP ${response.status}`);
    if (!id) return undefined;
    while (true) {
      const event = parseJsonRpc((await this.nextEvent()).data);
      if (event.id === id) return event;
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.reader?.cancel().catch(() => undefined);
    this.reader = undefined;
  }
}

export class RemoteMcpClient {
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private sessionId: string | undefined;
  private initialized = false;
  readonly diagnostics: string[] = [];
  private readonly legacy: LegacySseTransport | undefined;

  constructor(
    readonly connection: Connection,
    private readonly credential: string | undefined,
    private readonly request: typeof fetch = fetch,
  ) {
    if (connection.kind !== "mcp" || !connection.url)
      throw new IntegralError("remote MCP client requires an MCP URL");
    if (connection.transport === "stdio")
      throw new IntegralError("remote MCP client does not support stdio");
    if (connection.transport === "sse")
      this.legacy = new LegacySseTransport(connection, credential, request);
  }

  async initialize(signal?: AbortSignal): Promise<string> {
    if (this.initialized) return this.protocolVersion;
    if (this.legacy) {
      const initialized = await this.legacy.send("initialize", {
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "integral", version: "0.1.0" },
        }),
        result = rpcResult(initialized!, "initialize");
      if (typeof result.protocolVersion !== "string")
        throw new IntegralError(
          "MCP initialize result omitted protocolVersion",
        );
      this.protocolVersion = result.protocolVersion;
      await this.legacy.send("notifications/initialized", {}, true);
      this.initialized = true;
      return this.protocolVersion;
    }
    try {
      const discovered = await postRemote(
        this.connection,
        this.credential,
        MCP_PROTOCOL_VERSION,
        "server/discover",
        {},
        undefined,
        this.request,
        signal,
      );
      if (!discovered.response.error) {
        this.protocolVersion = MCP_PROTOCOL_VERSION;
        this.initialized = true;
        return this.protocolVersion;
      }
    } catch (error) {
      if (
        error instanceof IntegralError &&
        /HTTP (401|403)/.test(error.message)
      )
        throw error;
    }
    const initialized = await postRemote(
      this.connection,
      this.credential,
      MCP_SESSION_PROTOCOL_VERSION,
      "initialize",
      {
        protocolVersion: MCP_SESSION_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "integral", version: "0.1.0" },
      },
      undefined,
      this.request,
      signal,
    );
    const result = rpcResult(initialized.response, "initialize"),
      negotiated = result.protocolVersion;
    if (typeof negotiated !== "string")
      throw new IntegralError("MCP initialize result omitted protocolVersion");
    this.protocolVersion = negotiated;
    this.sessionId = initialized.sessionId;
    await this.notification("notifications/initialized", {}, signal);
    this.initialized = true;
    return this.protocolVersion;
  }

  private async notification(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.request(this.connection.url!, {
      method: "POST",
      headers: requestHeaders(
        this.connection,
        this.credential,
        this.protocolVersion,
        method,
        undefined,
        this.sessionId,
      ),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      ...(signal ? { signal } : {}),
      redirect: "manual",
    });
    if (!response.ok && response.status !== 202)
      throw new IntegralError(`MCP ${method} failed: HTTP ${response.status}`);
  }

  private async requestRpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await this.initialize(signal);
    if (this.legacy)
      return rpcResult((await this.legacy.send(method, params))!, method);
    const value = await postRemote(
      this.connection,
      this.credential,
      this.protocolVersion,
      method,
      params,
      this.sessionId,
      this.request,
      signal,
    );
    this.sessionId = value.sessionId;
    return rpcResult(value.response, method);
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor && cursors.has(cursor))
        throw new IntegralError("MCP tools/list repeated a pagination cursor");
      if (cursor) cursors.add(cursor);
      const result = await this.requestRpc(
          "tools/list",
          cursor ? { cursor } : {},
          signal,
        ),
        page = toolsFromListResult(result);
      tools.push(...page.tools);
      this.diagnostics.push(...page.diagnostics);
      cursor = page.nextCursor;
    } while (cursor);
    const duplicates = new Set<string>(),
      seen = new Set<string>();
    for (const tool of tools)
      if (seen.has(tool.name)) duplicates.add(tool.name);
      else seen.add(tool.name);
    return tools.filter((tool) => !duplicates.has(tool.name));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    return this.requestRpc("tools/call", { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    if (this.legacy) {
      await this.legacy.close();
      this.initialized = false;
      return;
    }
    if (!this.sessionId) return;
    await this.request(this.connection.url!, {
      method: "DELETE",
      headers: requestHeaders(
        this.connection,
        this.credential,
        this.protocolVersion,
        "session/delete",
        undefined,
        this.sessionId,
      ),
      redirect: "manual",
    }).catch(() => undefined);
    this.sessionId = undefined;
    this.initialized = false;
  }
}

export async function discoverRemoteMcp(
  connection: Connection,
  credential: string | undefined,
  request: typeof fetch = fetch,
): Promise<McpCatalog> {
  const client = new RemoteMcpClient(connection, credential, request),
    signal = AbortSignal.timeout(30_000);
  try {
    const protocolVersion = await client.initialize(signal),
      tools = await client.listTools(signal);
    return {
      connection,
      protocolVersion,
      tools,
      ...(client.diagnostics.length ? { diagnostics: client.diagnostics } : {}),
    };
  } finally {
    await client.close();
  }
}

export async function callRemoteMcp(
  connection: Connection,
  credential: string | undefined,
  tool: string,
  args: Record<string, unknown>,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  const client = new RemoteMcpClient(connection, credential, request);
  try {
    return await client.callTool(tool, args, signal);
  } finally {
    await client.close();
  }
}
