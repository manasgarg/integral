import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { EffectiveConfig } from "./config.ts";
import type { Connection } from "./connections.ts";
import type { ResourceProjection } from "./resources.ts";
import { IntegralError } from "./errors.ts";
import { atomicWrite, ensureDir } from "./fs.ts";
import { DEFAULT_PI_IMAGE, INTEGRAL_VERSION } from "./constants.ts";
import { OAUTH_SENTINEL, SENTINEL } from "./gateway-policy.ts";
import { DEFAULT_CONTAINER_PACKAGES } from "./container-packages.ts";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SESSION_PROTOCOL_VERSION,
  toolsFromListResult,
  type McpCatalog,
  type McpRuntime,
  type McpToolResult,
} from "./mcp.ts";
import {
  interpretPiEvent,
  type PiProtocolEvent,
} from "./container/pi-protocol.ts";
export {
  interpretPiProtocol,
  type PiProtocolEvent,
  type PiProtocolResult,
} from "./container/pi-protocol.ts";

export interface ContainerSpec {
  image: string;
  args: string[];
  environment: Record<string, string>;
  mounts: { source: string; target: string; readonly: boolean }[];
  sessionId: string;
  sessionToken: string;
  home: string;
  gatewayAddress: string;
}

export interface PiRuntime {
  readonly spec: ContainerSpec;
  start(): Promise<void>;
  prompt(text: string): Promise<string>;
  stop(): Promise<void>;
}
export interface TaskRuntime extends PiRuntime {
  finish(): Promise<number>;
}

export interface ContainerBackend {
  ensureImage(
    config: EffectiveConfig,
    piVersion: string,
    options?: {
      systemPackages?: readonly string[];
      rebuild?: boolean;
      expectedImage?: string;
    },
  ): string | Promise<string>;
  ensureNetwork(name: string): Promise<void>;
  networkGateway(name: string): string | Promise<string>;
  createPi(
    spec: ContainerSpec,
    config: EffectiveConfig,
    network: string,
    onStderr: (line: string) => void,
    onEvent?: (event: PiProtocolEvent) => void,
  ): PiRuntime;
  createTaskPi(
    spec: ContainerSpec,
    config: EffectiveConfig,
    network: string,
    onStderr: (line: string) => void,
    onEvent?: (event: PiProtocolEvent) => void,
  ): TaskRuntime;
  createMcpSidecar?(
    spec: McpSidecarSpec,
    config: EffectiveConfig,
    network: string,
    onStderr: (line: string) => void,
  ): McpRuntime;
}

export interface McpSidecarSpec {
  connection: Connection;
  image: string;
  sessionId: string;
  sessionToken: string;
  gatewayUrl: string;
  gatewayAddress: string;
  caCert: string;
  caBundle: string;
  secretValues: Record<string, string>;
}
const managed = new Set([
  "HOME",
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "PIP_CERT",
  "PI_CODING_AGENT_DIR",
  "NODE_USE_ENV_PROXY",
  "GH_TOKEN",
]);
export function isManagedContainerVariable(name: string): boolean {
  return managed.has(name) || name.startsWith("INTEGRAL_");
}

export function buildContainerSpec(options: {
  config: EffectiveConfig;
  gatewayUrl: string;
  gatewayAddress?: string;
  caCert: string;
  caBundle: string;
  sessionHome: string;
  sessionId: string;
  sessionToken: string;
  model: Connection;
  selectedModel: string;
  image?: string;
  mcp: Connection[];
  connections?: Connection[];
  historyView?: string;
}): ContainerSpec {
  const proxy = new URL(options.gatewayUrl);
  proxy.username = "integral";
  proxy.password = options.sessionToken;
  const proxyUrl = proxy.toString();
  const caPath = "/integral-ca/integral-ca.pem",
    bundlePath = "/integral-ca/ca-bundle.pem";
  const environment: Record<string, string> = {
    HOME: "/home/pi",
    PATH: "/home/pi/.local/bin:/usr/local/bin:/usr/bin:/bin",
    TMPDIR: "/tmp",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
    NODE_EXTRA_CA_CERTS: caPath,
    SSL_CERT_FILE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    REQUESTS_CA_BUNDLE: bundlePath,
    GIT_SSL_CAINFO: bundlePath,
    PIP_CERT: bundlePath,
    PI_CODING_AGENT_DIR: "/home/pi/.pi/agent",
    NODE_USE_ENV_PROXY: "1",
  };
  const provider = options.model.provider!;
  // Pi sees only a sentinel. The gateway swaps it for the host credential inside the allowed boundary.
  environment[
    provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
  ] = SENTINEL;
  if (
    options.connections?.some((connection) => connection.provider === "github")
  )
    environment.GH_TOKEN = SENTINEL;
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-approve",
    "--offline",
    "--provider",
    provider,
  ];
  if (options.model.auth !== "oauth" && options.model.auth !== "device-code")
    args.push("--api-key", SENTINEL);
  args.push("--model", options.selectedModel);
  const mounts = [
    { source: options.caCert, target: caPath, readonly: true },
    { source: options.caBundle, target: bundlePath, readonly: true },
    { source: options.sessionHome, target: "/home/pi", readonly: false },
  ];
  if (options.historyView)
    mounts.push({
      source: options.historyView,
      target: "/home/pi/history",
      readonly: true,
    });
  return {
    image: options.image ?? options.config.runner.image,
    args,
    environment,
    mounts,
    sessionId: options.sessionId,
    sessionToken: options.sessionToken,
    home: options.sessionHome,
    gatewayAddress: options.gatewayAddress ?? "host-gateway",
  };
}

export function dockerRunArgs(
  spec: ContainerSpec,
  config: EffectiveConfig,
  network: string,
): string[] {
  const result = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    `integral-${spec.sessionId}`,
    "--network",
    network,
    "--add-host",
    `host.integral.internal:${spec.gatewayAddress}`,
    "--user",
    "1000:1000",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--memory",
    `${config.runner.memoryMb}m`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${config.runner.tmpfsMb}m`,
  ];
  for (const [name, value] of Object.entries(spec.environment))
    result.push("--env", `${name}=${value}`);
  for (const mount of spec.mounts)
    result.push(
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`,
    );
  return [...result, spec.image, "pi", ...spec.args];
}

const MCP_BOOTSTRAP = `const { spawn } = require("node:child_process"); let buffered = Buffer.alloc(0), started = false; function data(chunk) { if (started) return; buffered = Buffer.concat([buffered, chunk]); const newline = buffered.indexOf(10); if (newline < 0) return; started = true; process.stdin.off("data", data); let secrets; try { secrets = JSON.parse(buffered.subarray(0, newline).toString("utf8")); } catch { process.stderr.write("invalid integral MCP secret bootstrap\\n"); process.exit(70); return; } const child = spawn(process.argv[1], process.argv.slice(2), { env: { ...process.env, ...secrets }, stdio: ["pipe", "pipe", "pipe"] }); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); const remaining = buffered.subarray(newline + 1); if (remaining.length) child.stdin.write(remaining); process.stdin.pipe(child.stdin); child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1))); child.on("error", (error) => { process.stderr.write(error.message + "\\n"); process.exit(70); }); } process.stdin.on("data", data); process.stdin.resume();`;

export function dockerMcpSidecarArgs(
  spec: McpSidecarSpec,
  config: EffectiveConfig,
  network: string,
): string[] {
  const proxy = new URL(spec.gatewayUrl);
  proxy.username = "integral";
  proxy.password = spec.sessionToken;
  const proxyUrl = proxy.toString(),
    name = `integral-mcp-${spec.sessionId}-${spec.connection.name.replace(/[^A-Za-z0-9_.-]/g, "-")}`,
    caPath = "/integral-ca/integral-ca.pem",
    bundlePath = "/integral-ca/ca-bundle.pem",
    environment: Record<string, string> = {
      HOME: "/tmp",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
      NODE_EXTRA_CA_CERTS: caPath,
      SSL_CERT_FILE: bundlePath,
      NODE_USE_ENV_PROXY: "1",
      ...(spec.connection.env ?? {}),
    },
    args = [
      "run",
      "--rm",
      "--interactive",
      "--name",
      name,
      "--network",
      network,
      "--add-host",
      `host.integral.internal:${spec.gatewayAddress}`,
      "--user",
      "1000:1000",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--read-only",
      "--memory",
      `${config.runner.memoryMb}m`,
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,size=${config.runner.tmpfsMb}m`,
    ];
  for (const [key, value] of Object.entries(environment))
    args.push("--env", `${key}=${value}`);
  for (const [source, target] of [
    [spec.caCert, caPath],
    [spec.caBundle, bundlePath],
  ])
    args.push(
      "--mount",
      `type=bind,source=${source},target=${target},readonly`,
    );
  return [
    ...args,
    spec.image,
    "node",
    "-e",
    MCP_BOOTSTRAP,
    spec.connection.command!,
    ...(spec.connection.args ?? []),
  ];
}

interface PendingMcpRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

export class StdioMcpSidecar implements McpRuntime {
  readonly connection: Connection;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private readonly pending = new Map<number, PendingMcpRequest>();

  constructor(
    private readonly spec: McpSidecarSpec,
    private readonly config: EffectiveConfig,
    private readonly network: string,
    private readonly diagnostic: (line: string) => void = () => undefined,
  ) {
    this.connection = spec.connection;
  }

  async start(): Promise<McpCatalog> {
    if (this.child)
      throw new IntegralError(
        `MCP sidecar ${this.connection.name} is already running`,
      );
    const child = spawn(
      "docker",
      dockerMcpSidecarArgs(this.spec, this.config, this.network),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.protocol(line),
    );
    createInterface({ input: child.stderr }).on("line", (line) =>
      this.diagnostic(this.sanitize(line)),
    );
    child.once("exit", (code) => {
      const error = new IntegralError(
        `MCP sidecar ${this.connection.name} exited (${code ?? "signal"})`,
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      if (this.child === child) this.child = undefined;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.stdin.write(`${JSON.stringify(this.spec.secretValues)}\n`);
    try {
      const discovery = await this.request("server/discover", {});
      if (discovery.error === undefined) {
        this.protocolVersion = MCP_PROTOCOL_VERSION;
      } else {
        const initialized = await this.request("initialize", {
          protocolVersion: MCP_SESSION_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "integral", version: INTEGRAL_VERSION },
        });
        const result = this.result(initialized, "initialize");
        if (typeof result.protocolVersion !== "string")
          throw new IntegralError(
            "MCP initialize result omitted protocolVersion",
          );
        this.protocolVersion = result.protocolVersion;
        this.notify("notifications/initialized", {});
      }
      const tools = [],
        diagnostics: string[] = [],
        names = new Set<string>(),
        seen = new Set<string>();
      let cursor: string | undefined;
      do {
        if (cursor && seen.has(cursor))
          throw new IntegralError(
            "MCP tools/list repeated a pagination cursor",
          );
        if (cursor) seen.add(cursor);
        const page = toolsFromListResult(
          this.result(
            await this.request("tools/list", cursor ? { cursor } : {}),
            "tools/list",
          ),
        );
        tools.push(...page.tools);
        diagnostics.push(...page.diagnostics);
        cursor = page.nextCursor;
      } while (cursor);
      const duplicates = new Set<string>();
      for (const tool of tools)
        if (names.has(tool.name)) duplicates.add(tool.name);
        else names.add(tool.name);
      for (const name of duplicates)
        diagnostics.push(`${name}: MCP tool name is duplicated`);
      return {
        connection: this.connection,
        protocolVersion: this.protocolVersion,
        tools: tools.filter((tool) => !duplicates.has(tool.name)),
        ...(diagnostics.length ? { diagnostics } : {}),
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    return this.result(
      await this.request(
        "tools/call",
        { name, arguments: args },
        signal,
        this.config.runner.turnTimeoutSeconds * 1000,
      ),
      "tools/call",
    );
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child)
      return Promise.reject(
        new IntegralError(`MCP sidecar ${this.connection.name} is not running`),
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "timeout",
        });
        reject(new IntegralError(`MCP ${method} timed out`));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "cancelled",
        });
        reject(new IntegralError(`MCP ${method} was cancelled`));
      };
      if (signal?.aborted) return abort();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  private protocol(line: string): void {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
      if (!value || typeof value !== "object" || value.jsonrpc !== "2.0")
        throw new Error("invalid JSON-RPC envelope");
    } catch {
      const error = new IntegralError(
        `MCP sidecar ${this.connection.name} wrote non-protocol output to stdout`,
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      void this.stop();
      return;
    }
    if (typeof value.id !== "number") return;
    const request = this.pending.get(value.id);
    if (!request) return;
    this.pending.delete(value.id);
    request.resolve(value);
  }

  private result(
    response: Record<string, unknown>,
    method: string,
  ): Record<string, unknown> {
    if (response.error && typeof response.error === "object") {
      const error = response.error as Record<string, unknown>;
      const detail =
        typeof error.message === "string"
          ? error.message
          : typeof error.code === "string" || typeof error.code === "number"
            ? String(error.code)
            : "unknown error";
      throw new IntegralError(`MCP ${method} failed: ${detail}`);
    }
    if (
      !response.result ||
      typeof response.result !== "object" ||
      Array.isArray(response.result)
    )
      throw new IntegralError(`MCP ${method} result must be an object`);
    return response.result as Record<string, unknown>;
  }

  private sanitize(line: string): string {
    let clean = line.replace(/[\r\n]/g, " ");
    for (const secret of Object.values(this.spec.secretValues))
      if (secret) clean = clean.split(secret).join("[REDACTED]");
    return clean;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    for (const request of this.pending.values())
      request.reject(
        new IntegralError(`MCP sidecar ${this.connection.name} stopped`),
      );
    this.pending.clear();
    const exited = new Promise<boolean>((resolve) =>
      child.once("exit", () => resolve(true)),
    );
    child.stdin.end();
    const stopped = await Promise.race([
      exited,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!stopped) {
      spawnSync(
        "docker",
        [
          "rm",
          "--force",
          `integral-mcp-${this.spec.sessionId}-${this.connection.name.replace(/[^A-Za-z0-9_.-]/g, "-")}`,
        ],
        { stdio: "ignore" },
      );
      await exited;
    }
  }
}

export async function writeMcpExtension(
  sessionHome: string,
  catalogs: McpCatalog[],
): Promise<void> {
  const directory = join(sessionHome, ".pi", "agent", "extensions");
  await ensureDir(directory);
  const declarations = catalogs.flatMap((catalog) =>
    catalog.tools.map((tool) => ({
      connection: catalog.connection.name,
      name: mcpToolName(catalog.connection.name, tool.name),
      remoteName: tool.name,
      label: tool.title ?? `${catalog.connection.name}: ${tool.name}`,
      description:
        tool.description ??
        `Call ${tool.name} on the ${catalog.connection.name} MCP server`,
      parameters: tool.inputSchema,
    })),
  );
  const source = `import { request } from "node:http";
import { Type } from "typebox";
const tools = ${JSON.stringify(declarations)};
function control(path) { const proxy = new URL(process.env.HTTP_PROXY), target = new URL(path, "http://integral.control"), authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = target.pathname; proxy.search = target.search; return { url: proxy.toString(), authorization }; }
function controlRequest(path, method, body, signal) { return new Promise((resolve, reject) => { const target = control(path), payload = body === undefined ? undefined : JSON.stringify(body), chunks = []; let settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }, req = request(target.url, { agent: false, method, headers: { "content-type": "application/json", "proxy-authorization": target.authorization, ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }) } }, (res) => { res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => finish(() => resolve({ status: res.statusCode || 500, text: Buffer.concat(chunks).toString("utf8") }))); res.on("error", (error) => finish(() => reject(error))); }), abort = () => req.destroy(new Error("schedule request was cancelled")); signal?.addEventListener("abort", abort, { once: true }); req.on("error", (error) => finish(() => reject(error))); req.end(payload); }); }
async function schedule(path, method, body, signal) { const response = await controlRequest(path, method, body, signal), text = response.text; if (response.status < 200 || response.status >= 300) throw new Error("Schedule request failed: " + response.status + " " + text.trim()); return text ? JSON.parse(text) : null; }
async function mcp(tool, args, signal) { const response = await controlRequest("/integral/mcp", "POST", { connection: tool.connection, tool: tool.remoteName, arguments: args }, signal), text = response.text; if (response.status < 200 || response.status >= 300) throw new Error(text.trim() || "MCP tool call failed"); return text ? JSON.parse(text) : {}; }
function result(value) { return { content: [{ type: "text", text: JSON.stringify(value) }], details: value }; }
export default function (pi) {
  for (const tool of tools) pi.registerTool({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, async execute(_id, params, signal) { const value = await mcp(tool, params, signal); return { content: value.content || [{ type: "text", text: JSON.stringify(value.structuredContent ?? value) }], details: { connection: tool.connection, tool: tool.remoteName, structuredContent: value.structuredContent, isError: value.isError === true } }; } });
  pi.registerTool({ name: "schedule_list", label: "List schedules", description: "List schedules managed by Integral", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await schedule("/integral/control/schedules", "GET", undefined, signal)); } });
  pi.registerTool({ name: "schedule_create", label: "Create schedule", description: "Create a recurring cron schedule or one-time task", parameters: Type.Object({ prompt: Type.String(), cron: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()), runAt: Type.Optional(Type.String()) }), async execute(_id, params, signal) { const trigger = params.runAt ? { type: "once", runAt: params.runAt } : { type: "recurring", cron: params.cron, timezone: params.timezone }; return result(await schedule("/integral/control/schedules", "POST", { prompt: params.prompt, trigger }, signal)); } });
  for (const action of ["enable", "disable"]) pi.registerTool({ name: "schedule_" + action, label: action + " schedule", description: action + " a schedule", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id) + "/" + action, "POST", { expectedRevision: params.expectedRevision }, signal)); } });
  pi.registerTool({ name: "schedule_update", label: "Update schedule", description: "Update a schedule using its current revision", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer(), prompt: Type.Optional(Type.String()), cron: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()), runAt: Type.Optional(Type.String()) }), async execute(_id, params, signal) { const trigger = params.runAt ? { type: "once", runAt: params.runAt } : params.cron || params.timezone ? { type: "recurring", cron: params.cron, timezone: params.timezone } : undefined; return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id), "PATCH", { expectedRevision: params.expectedRevision, prompt: params.prompt, trigger }, signal)); } });
  pi.registerTool({ name: "schedule_delete", label: "Delete schedule", description: "Delete a schedule using its current revision", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/schedules/" + encodeURIComponent(params.id), "DELETE", { expectedRevision: params.expectedRevision }, signal)); } });
  pi.registerTool({ name: "container_package_list", label: "List container packages", description: "List the governed Debian package set and current revision for the managed Pi image", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await schedule("/integral/control/container-packages", "GET", undefined, signal)); } });
  for (const operation of ["install", "upgrade"]) pi.registerTool({ name: "container_package_" + operation, label: operation + " container packages", description: operation + " Debian packages through Integral's governed immutable-image builder; the current container is replaced after this turn", parameters: Type.Object({ packages: Type.Array(Type.String()), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await schedule("/integral/control/container-packages", "POST", { operation, packages: params.packages, expectedRevision: params.expectedRevision }, signal)); } });
}
`;
  await atomicWrite(join(directory, "integral-mcp.ts"), source);
}

export function mcpToolName(connection: string, tool: string): string {
  const readable = `mcp_${connection}_${tool}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .slice(0, 54);
  const suffix = createHash("sha256")
    .update(`${connection}\0${tool}`)
    .digest("hex")
    .slice(0, 8);
  return `${readable}_${suffix}`;
}

export async function writeEmailExtension(
  sessionHome: string,
  connections: Connection[],
): Promise<void> {
  if (!connections.length) return;
  const directory = join(sessionHome, ".pi", "agent", "extensions");
  await ensureDir(directory);
  const declarations = connections.map((connection) => ({
    name: connection.name,
    toolName: connection.name.replace(/[^A-Za-z0-9_]/g, "_"),
    capabilities: connection.capabilities,
  }));
  const source = `import { request } from "node:http";
import { Type } from "typebox";
const accounts = ${JSON.stringify(declarations)};
function endpoint() { const proxy = new URL(process.env.HTTP_PROXY); const authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = "/integral/email"; return { url: proxy.toString(), authorization }; }
function transportFailure(error, signal) { if (signal?.aborted) return new Error("email gateway request was cancelled"); const cause = error && typeof error === "object" && error.cause && typeof error.cause === "object" ? error.cause : error; const code = cause && typeof cause === "object" && typeof cause.code === "string" && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : undefined; return new Error("email gateway request failed" + (code ? ": " + code : "")); }
function post(target, body, signal) { return new Promise((resolve, reject) => { if (signal?.aborted) { reject(transportFailure(undefined, signal)); return; } const chunks = []; let size = 0, settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }; const req = request(target.url, { agent: false, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "proxy-authorization": target.authorization } }, (res) => { res.on("data", (chunk) => { size += chunk.length; if (size > 500000) req.destroy(new Error("email gateway response exceeded limit")); else chunks.push(chunk); }); res.on("end", () => finish(() => resolve({ status: res.statusCode || 500, text: Buffer.concat(chunks).toString("utf8") }))); res.on("error", (error) => finish(() => reject(error))); }); const abort = () => req.destroy(transportFailure(undefined, signal)); signal?.addEventListener("abort", abort, { once: true }); req.on("error", (error) => finish(() => reject(error))); req.end(body); }); }
async function call(connection, operation, params, signal) { const target = endpoint(); let response; try { response = await post(target, JSON.stringify({ connection, operation, ...params }), signal); } catch (error) { throw transportFailure(error, signal); } if (response.status < 200 || response.status >= 300) throw new Error(response.text.trim() || "email operation failed"); return JSON.parse(response.text); }
const schemas = {
  search: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })) }),
  read: Type.Object({ messageId: Type.String() }),
  send: Type.Object({ to: Type.Array(Type.String()), cc: Type.Optional(Type.Array(Type.String())), bcc: Type.Optional(Type.Array(Type.String())), subject: Type.String(), text: Type.String() })
};
export default function (pi) { for (const account of accounts) for (const capability of account.capabilities) pi.registerTool({ name: "email_" + account.toolName + "_" + capability, label: "Email " + account.name + " " + capability, description: capability + " email using the " + account.name + " account", parameters: schemas[capability], async execute(_id, params, signal) { const result = await call(account.name, capability, params, signal); return { content: [{ type: "text", text: JSON.stringify(result) }], details: { account: account.name, capability } }; } }); }
`;
  await atomicWrite(join(directory, "integral-email.ts"), source);
}

export async function writeResourceExtension(
  sessionHome: string,
  projection: ResourceProjection,
): Promise<void> {
  const directory = join(sessionHome, ".pi", "agent", "extensions");
  await ensureDir(directory);
  const repositories = projection.repositories.map(({ resource }) => ({
    id: resource.id,
    name: resource.connection,
    mount: resource.mount,
  }));
  const stores = projection.stores.map((resource) => ({
    id: resource.id,
    name: resource.connection,
    mount: resource.mount,
  }));
  const source = `import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
const run = promisify(execFile), repositories = ${JSON.stringify(repositories)};
function endpoint(path) { const proxy = new URL(process.env.HTTP_PROXY), authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = path; proxy.search = ""; return { url: proxy.toString(), authorization }; }
function call(path, method, body, signal) { return new Promise((resolve, reject) => { const target = endpoint(path), payload = body === undefined ? undefined : JSON.stringify(body), chunks = []; let settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }, req = request(target.url, { agent: false, method, headers: { "content-type": "application/json", "proxy-authorization": target.authorization, ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }) } }, (res) => { res.on("data", chunk => chunks.push(chunk)); res.on("end", () => finish(() => { const text = Buffer.concat(chunks).toString("utf8"); if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) reject(new Error(text.trim() || "resource operation failed")); else resolve(text ? JSON.parse(text) : null); })); }), abort = () => req.destroy(new Error("resource request was cancelled")); signal?.addEventListener("abort", abort, { once: true }); req.on("error", error => finish(() => reject(error))); req.end(payload); }); }
function result(value) { return { content: [{ type: "text", text: JSON.stringify(value) }], details: value }; }
export default function (pi) {
  for (const kind of ["repo", "store"]) {
    pi.registerTool({ name: kind + "_list", label: "List governed " + kind + "s", description: "List governed " + kind + " resources without exposing host paths", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await call("/integral/control/resources/" + kind + "s", "GET", undefined, signal)); } });
    pi.registerTool({ name: kind + "_create", label: "Create governed " + kind, description: "Create and attach a host-managed " + kind + "; the current session is replaced after success", parameters: Type.Object({ name: Type.String(), mount: Type.String() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/" + kind + "s", "POST", params, signal)); } });
    pi.registerTool({ name: kind + "_delete", label: "Soft-delete governed " + kind, description: "Remove this resource from future sessions while the current session keeps its mount", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/" + kind + "s/" + encodeURIComponent(params.id), "DELETE", params, signal)); } });
    pi.registerTool({ name: kind + "_restore", label: "Restore governed " + kind, description: "Restore a soft-deleted resource at a mount path; the current session is replaced after success", parameters: Type.Object({ id: Type.String(), expectedRevision: Type.Integer(), mount: Type.String() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/" + kind + "s/" + encodeURIComponent(params.id) + "/restore", "POST", params, signal)); } });
  }
  pi.registerTool({ name: "repo_push", label: "Push governed repository", description: "Commit changes first, then land the current commit through Integral's validated host boundary; the protected image-recipe repository requires human approval", parameters: Type.Object({ id: Type.String() }), async execute(_id, params, signal) { const repository = repositories.find(value => value.id === params.id || value.name === params.id); if (!repository) throw new Error("repository is not mounted in this session"); const checkout = repository.mount, proposed = (await run("git", ["rev-parse", "HEAD"], { cwd: checkout, signal })).stdout.trim(), bundle = join(tmpdir(), "integral-" + crypto.randomUUID() + ".bundle"); try { await run("git", ["bundle", "create", bundle, "HEAD"], { cwd: checkout, signal }); const encoded = (await readFile(bundle)).toString("base64"); return result(await call("/integral/control/resources/repos/" + encodeURIComponent(repository.id) + "/push", "POST", { proposed, bundle: encoded }, signal)); } finally { await rm(bundle, { force: true }); } } });
  pi.registerTool({ name: "container_image_rebuild", label: "Rebuild managed Pi image", description: "Request a fresh pull and no-cache rebuild of the active Dockerfile; this requires human approval and replaces the container after resolution", parameters: Type.Object({}), async execute(_id, _params, signal) { return result(await call("/integral/control/image-rebuild", "POST", {}, signal)); } });
  pi.registerTool({ name: "store_snapshot_list", label: "List store snapshots", description: "List retained snapshots for a governed store", parameters: Type.Object({ id: Type.String() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/stores/" + encodeURIComponent(params.id) + "/snapshots", "GET", undefined, signal)); } });
  pi.registerTool({ name: "store_snapshot_restore", label: "Restore store snapshot", description: "Restore retained store bytes using the current lifecycle revision", parameters: Type.Object({ id: Type.String(), snapshotId: Type.String(), expectedRevision: Type.Integer() }), async execute(_id, params, signal) { return result(await call("/integral/control/resources/stores/" + encodeURIComponent(params.id) + "/snapshots/" + encodeURIComponent(params.snapshotId) + "/restore", "POST", params, signal)); } });
}
`;
  await atomicWrite(join(directory, "integral-resources.ts"), source);
  const bin = join(sessionHome, ".local", "bin"),
    helper = join(bin, "integral-lock"),
    lockSource = `#!/usr/bin/env node
import { request } from "node:http";
import { spawn } from "node:child_process";
const stores = ${JSON.stringify(stores)};
function usage() { console.error("usage: integral-lock <store-id|name|mount> <lock-name> -- <command> [args...]"); process.exit(2); }
function call(path, method, body) { return new Promise((resolve, reject) => { const proxy = new URL(process.env.HTTP_PROXY), authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"), payload = body === undefined ? undefined : JSON.stringify(body), chunks = []; proxy.username = ""; proxy.password = ""; proxy.pathname = path; proxy.search = ""; const req = request(proxy, { method, headers: { "content-type": "application/json", "proxy-authorization": authorization, ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }) } }, res => { res.on("data", chunk => chunks.push(chunk)); res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) reject(new Error(text.trim() || "store lock request failed")); else resolve(text ? JSON.parse(text) : null); }); }); req.on("error", reject); req.end(payload); }); }
const separator = process.argv.indexOf("--"), selector = process.argv[2], name = process.argv[3];
if (!selector || !name || separator !== 4 || !process.argv[5]) usage();
const store = stores.find(value => value.id === selector || value.name === selector || value.mount === selector);
if (!store) throw new Error("store is not mounted in this session: " + selector);
const path = "/integral/control/resources/stores/" + encodeURIComponent(store.id) + "/locks/" + encodeURIComponent(name), acquired = await call(path, "POST"), command = process.argv[5], args = process.argv.slice(6);
let code = 1;
try { code = await new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: "inherit", env: process.env }); child.on("error", reject); child.on("exit", (value, signal) => resolve(value ?? (signal ? 128 : 1))); }); }
finally { await call(path, "DELETE", { lease: acquired.lease }).catch(error => console.error("integral-lock: " + error.message)); }
process.exitCode = code;
`;
  await ensureDir(bin);
  await atomicWrite(helper, lockSource, 0o700);
  await chmod(helper, 0o700);
}

export async function writeTaskExtension(sessionHome: string): Promise<void> {
  const directory = join(sessionHome, ".pi", "agent", "extensions");
  await ensureDir(directory);
  const source = `import { request } from "node:http";
import { Type } from "typebox";
let declaredOutcome;
function endpoint() { const proxy = new URL(process.env.HTTP_PROXY); const authorization = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64"); proxy.username = ""; proxy.password = ""; proxy.pathname = "/integral/task-outcome"; return { url: proxy.toString(), authorization }; }
function post(body, signal) { return new Promise((resolve, reject) => { const target = endpoint(), payload = JSON.stringify(body), chunks = []; let settled = false; const finish = (action) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); action(); }, req = request(target.url, { agent: false, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "proxy-authorization": target.authorization } }, (res) => { res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => finish(() => resolve({ status: res.statusCode || 500, text: Buffer.concat(chunks).toString("utf8") }))); res.on("error", (error) => finish(() => reject(error))); }), abort = () => req.destroy(new Error("task outcome request was cancelled")); signal?.addEventListener("abort", abort, { once: true }); req.on("error", (error) => finish(() => reject(error))); req.end(payload); }); }
async function declare(outcome, message, signal) { const response = await post({ outcome, message }, signal); if (response.status < 200 || response.status >= 300) throw new Error(response.text.trim() || "task outcome declaration failed"); declaredOutcome = outcome; return { content: [{ type: "text", text: outcome === "complete" ? "Task completion recorded." : "Task failure recorded." }], details: { outcome, message }, terminate: true }; }
export default function (pi) {
  pi.registerTool({ name: "task_complete", label: "Complete task", description: "Declare that the isolated scheduled task completed successfully. This must be your final action when the task succeeded.", promptSnippet: "Declare successful completion of the scheduled task", promptGuidelines: ["Call task_complete as the final action when the scheduled task has succeeded."], parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 100000 }) }), async execute(_id, params, signal) { return declare("complete", params.summary, signal); } });
  pi.registerTool({ name: "task_fail", label: "Fail task", description: "Declare that the isolated scheduled task could not be completed. This must be your final action when the task failed.", promptSnippet: "Declare failure of the scheduled task", promptGuidelines: ["Call task_fail as the final action when the scheduled task cannot be completed."], parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 100000 }) }), async execute(_id, params, signal) { return declare("failed", params.reason, signal); } });
  pi.on("turn_end", async (event) => { if (declaredOutcome || event.toolResults?.length) return; pi.sendMessage({ customType: "integral-task-outcome-required", content: "You attempted to finish this scheduled task without declaring its outcome. Review the work and call exactly one of task_complete or task_fail now. Do not answer with ordinary text.", display: true }, { deliverAs: "steer", triggerTurn: true }); });
}
`;
  await atomicWrite(join(directory, "integral-task.ts"), source);
}

export async function writePiCredential(
  sessionHome: string,
  model: Connection,
): Promise<void> {
  const directory = join(sessionHome, ".pi", "agent");
  await ensureDir(directory);
  const credential =
    model.auth === "oauth" || model.auth === "device-code"
      ? {
          type: "oauth",
          access: OAUTH_SENTINEL,
          refresh: SENTINEL,
          expires: Number.MAX_SAFE_INTEGER,
        }
      : { type: "api_key", key: SENTINEL };
  await atomicWrite(
    join(directory, "auth.json"),
    `${JSON.stringify({ [model.provider!]: credential })}\n`,
  );
}

export function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}
function inspectImage(image: string): string | undefined {
  const result = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

export function managedPiImage(
  version: string,
  recipeInputs?: readonly Uint8Array[],
  systemPackages: readonly string[] = DEFAULT_CONTAINER_PACKAGES,
): string {
  const dockerfile = fileURLToPath(
      new URL("../../Dockerfile.pi", import.meta.url),
    ),
    modelBridge = fileURLToPath(
      new URL("../../bin/integral-pi-models.mjs", import.meta.url),
    ),
    inputs = recipeInputs ?? [
      readFileSync(dockerfile),
      readFileSync(modelBridge),
    ],
    hash = createHash("sha256");
  for (const input of inputs)
    hash.update(String(input.byteLength)).update("\0").update(input);
  hash.update("packages\0").update(JSON.stringify([...systemPackages].sort()));
  const recipe = hash.digest("hex").slice(0, 12);
  return `integral-pi:${INTEGRAL_VERSION}-recipe-${recipe}-pi-${version.replace(/[^0-9A-Za-z_.-]/g, "-")}`;
}

export function ensureContainerImage(
  config: EffectiveConfig,
  piVersion: string,
  options: {
    systemPackages?: readonly string[];
    rebuild?: boolean;
    expectedImage?: string;
  } = {},
): string {
  if (options.expectedImage) {
    const selected = inspectImage(options.expectedImage);
    if (selected) return selected;
  }
  const systemPackages = [
    ...(options.systemPackages ?? DEFAULT_CONTAINER_PACKAGES),
  ].sort();
  const requested =
    config.runner.image === DEFAULT_PI_IMAGE
      ? managedPiImage(piVersion, undefined, systemPackages)
      : config.runner.image;
  const existing = inspectImage(requested);
  if (config.runner.pullPolicy === "never") {
    if (!existing)
      throw new IntegralError(
        `container image is unavailable and pull_policy is never: ${requested}`,
      );
    return existing;
  }
  if (
    config.runner.pullPolicy === "if-not-present" &&
    existing &&
    !options.rebuild
  )
    return existing;
  if (config.runner.image === DEFAULT_PI_IMAGE) {
    const dockerfile = fileURLToPath(
      new URL("../../Dockerfile.pi", import.meta.url),
    );
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = spawnSync(
      "docker",
      [
        "build",
        "--pull",
        ...(options.rebuild ? ["--no-cache"] : []),
        "--build-arg",
        `PI_VERSION=${piVersion}`,
        "--build-arg",
        `SYSTEM_PACKAGES=${systemPackages.join(" ")}`,
        "--tag",
        requested,
        "--file",
        dockerfile,
        root,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new IntegralError(
        `cannot build Pi ${piVersion} image: ${result.stderr.trim()}`,
      );
    const identity = inspectImage(requested);
    if (!identity)
      throw new IntegralError(`cannot resolve Pi ${piVersion} image identity`);
    return identity;
  }
  const result = spawnSync("docker", ["pull", requested], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new IntegralError(
      `cannot pull Pi image ${requested}: ${result.stderr.trim()}`,
    );
  const identity = inspectImage(requested);
  if (!identity)
    throw new IntegralError(`cannot resolve Pi image identity: ${requested}`);
  return identity;
}

export async function discoverPiModels(
  image: string,
  providers: readonly string[],
): Promise<Array<{ provider: string; model: string }>> {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      image,
      "integral-pi-models",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new IntegralError(
      `cannot discover models from Pi image: ${result.stderr.trim() || "container failed; the image must provide integral-pi-models"}`,
    );
  return parsePiModelList(result.stdout, providers);
}

export function parsePiModelList(
  output: string,
  providers: readonly string[],
): Array<{ provider: string; model: string }> {
  const allowed = new Set(providers);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IntegralError("Pi image returned an invalid model catalog");
  }
  if (!Array.isArray(parsed))
    throw new IntegralError("Pi image returned an invalid model catalog");
  return (parsed as unknown[]).filter(
    (entry: unknown): entry is { provider: string; model: string } =>
      typeof entry === "object" &&
      entry !== null &&
      "provider" in entry &&
      typeof entry.provider === "string" &&
      allowed.has(entry.provider) &&
      "model" in entry &&
      typeof entry.model === "string" &&
      Boolean(entry.model),
  );
}

export function discoverPiVersion(image: string): string {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      image,
      "pi",
      "--version",
    ],
    { encoding: "utf8" },
  );
  const version = result.stdout.trim();
  if (result.status !== 0 || !version)
    throw new IntegralError(
      `cannot identify Pi image version: ${result.stderr.trim() || "container failed"}`,
    );
  return version;
}
export async function createLockedNetwork(name: string): Promise<void> {
  const inspect = spawnSync("docker", ["network", "inspect", name], {
    stdio: "ignore",
  });
  if (inspect.status === 0) return;
  const created = spawnSync(
    "docker",
    ["network", "create", "--internal", name],
    { encoding: "utf8" },
  );
  if (created.status !== 0)
    throw new IntegralError(
      `cannot create locked Docker network: ${created.stderr.trim()}`,
    );
}
export function dockerNetworkGateway(name: string): string {
  const result = spawnSync(
    "docker",
    [
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      name,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim())
    throw new IntegralError("cannot discover locked Docker network gateway");
  return result.stdout.trim();
}

export class PiContainer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private response = "";
  private pending:
    | {
        resolve: (text: string) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private exit: Promise<number | null> | undefined;
  constructor(
    readonly spec: ContainerSpec,
    private readonly config: EffectiveConfig,
    private readonly network: string,
    private readonly diagnostic: (line: string) => void = () => undefined,
    private readonly observe: (event: PiProtocolEvent) => void = () =>
      undefined,
  ) {}
  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(
      "docker",
      dockerRunArgs(this.spec, this.config, this.network),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    this.exit = new Promise((resolve) => child.once("exit", resolve));
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.protocol(line),
    );
    createInterface({ input: child.stderr }).on("line", (line) =>
      this.diagnostic(line.replace(/[\r\n]/g, " ")),
    );
    child.once("exit", (code) => {
      const error = new IntegralError(
        `Pi container exited unexpectedly (${code ?? "signal"})`,
      );
      this.pending?.reject(error);
      this.pending = undefined;
      this.child = undefined;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  private protocol(line: string): void {
    let raw: PiProtocolEvent;
    try {
      raw = JSON.parse(line) as PiProtocolEvent;
    } catch {
      return;
    }
    try {
      this.observe(raw);
    } catch (error) {
      this.diagnostic(
        `run event observer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!this.pending) return;
    const event = interpretPiEvent(raw);
    if (event.type === "rejected") {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(new IntegralError(event.error));
      return;
    }
    if (event.type === "text") this.response += event.text;
    if (event.type === "complete") {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(this.response);
    }
  }
  prompt(text: string): Promise<string> {
    if (!this.child)
      return Promise.reject(new IntegralError("Pi container is not running"));
    if (this.pending)
      return Promise.reject(new IntegralError("Pi turn already in flight"));
    this.response = "";
    this.child.stdin.write(
      `${JSON.stringify({ type: "prompt", message: text })}\n`,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new IntegralError("Pi turn timed out"));
        void this.stop();
      }, this.config.runner.turnTimeoutSeconds * 1000);
      this.pending = { resolve, reject, timer };
    });
  }
  async finish(): Promise<number> {
    const child = this.child,
      exit = this.exit;
    if (!child || !exit) throw new IntegralError("Pi container is not running");
    if (this.pending) throw new IntegralError("Pi turn is still in flight");
    child.stdin.end();
    const result = await Promise.race([
      exit,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 5_000),
      ),
    ]);
    if (result === "timeout") {
      await this.stop();
      throw new IntegralError("Pi task did not exit cleanly after completion");
    }
    return result ?? 128;
  }
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(new IntegralError("Pi container stopped"));
    }
    if (child) {
      const exited = new Promise<boolean>((resolve) =>
        child.once("exit", () => resolve(true)),
      );
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!stopped) {
        spawnSync(
          "docker",
          ["rm", "--force", `integral-${this.spec.sessionId}`],
          {
            stdio: "ignore",
          },
        );
        await exited;
      }
    }
    await rm(this.spec.home, { recursive: true, force: true });
  }
}

export const dockerContainerBackend: ContainerBackend = {
  ensureImage: ensureContainerImage,
  ensureNetwork: createLockedNetwork,
  networkGateway: dockerNetworkGateway,
  createPi(spec, config, network, onStderr, onEvent) {
    return new PiContainer(spec, config, network, onStderr, onEvent);
  },
  createTaskPi(spec, config, network, onStderr, onEvent) {
    return new PiContainer(spec, config, network, onStderr, onEvent);
  },
  createMcpSidecar(spec, config, network, onStderr) {
    return new StdioMcpSidecar(spec, config, network, onStderr);
  },
};

export async function freshSessionHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "integral-pi-"));
}
export function newSessionIdentity(): {
  sessionId: string;
  sessionToken: string;
} {
  return {
    sessionId: randomUUID(),
    sessionToken: `${randomUUID()}${randomUUID()}`,
  };
}
