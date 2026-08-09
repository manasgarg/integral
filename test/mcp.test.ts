import assert from "node:assert/strict";
import test from "node:test";
import { validateConnection } from "../src/connections.ts";
import {
  discoverMcpAuthorization,
  discoverRemoteMcp,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SESSION_PROTOCOL_VERSION,
  RemoteMcpClient,
  toolsFromListResult,
} from "../src/mcp.ts";

function connection() {
  return validateConnection({
    name: "docs",
    kind: "mcp",
    url: "https://mcp.test/mcp",
    auth: "none",
  });
}

function bodyText(init: RequestInit): string {
  if (typeof init.body !== "string") throw new Error("expected string body");
  return init.body;
}

function inputUrl(input: string | URL | Request): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function rpc(init: RequestInit, result?: unknown, error?: unknown): Response {
  const request = JSON.parse(bodyText(init)) as { id?: string };
  return Response.json({
    jsonrpc: "2.0",
    id: request.id,
    ...(error ? { error } : { result }),
  });
}

test("[MCP-DB6BD516] [MCP-007BCE08] stateless remote discovery reads every tool page with routing metadata", async () => {
  const seen: Array<{ method: string; headers: Headers; params: unknown }> = [];
  const request: typeof fetch = async (_input, init = {}) => {
    const body = JSON.parse(bodyText(init)) as {
      method: string;
      params: Record<string, unknown>;
    };
    seen.push({
      method: body.method,
      headers: new Headers(init.headers),
      params: body.params,
    });
    if (body.method === "server/discover")
      return rpc(init, { capabilities: { tools: {} } });
    if (body.params.cursor === "next")
      return rpc(init, {
        tools: [
          {
            name: "read",
            description: "Read a page",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        ],
      });
    return rpc(init, {
      tools: [
        {
          name: "search",
          title: "Search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
      nextCursor: "next",
    });
  };
  const catalog = await discoverRemoteMcp(connection(), undefined, request);
  assert.equal(catalog.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(
    catalog.tools.map((tool) => tool.name),
    ["search", "read"],
  );
  assert.deepEqual(
    seen.map((value) => value.method),
    ["server/discover", "tools/list", "tools/list"],
  );
  assert.equal(seen[1]?.headers.get("mcp-method"), "tools/list");
  assert.equal(
    seen[1]?.headers.get("mcp-protocol-version"),
    MCP_PROTOCOL_VERSION,
  );
});

test("[MCP-DB6BD516] [MCP-2F0F5CB5] sessionful servers initialize, retain their session, and receive tool calls", async () => {
  const methods: string[] = [];
  const request: typeof fetch = async (_input, init = {}) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(bodyText(init)) as {
      method: string;
      params: Record<string, unknown>;
    };
    methods.push(body.method);
    if (body.method === "server/discover")
      return rpc(init, undefined, { code: -32601, message: "not found" });
    if (body.method === "initialize")
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: (JSON.parse(bodyText(init)) as { id: string }).id,
          result: {
            protocolVersion: MCP_SESSION_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "test", version: "1" },
          },
        }),
        { headers: { "mcp-session-id": "session-1" } },
      );
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (body.method === "tools/list") return rpc(init, { tools: [] });
    assert.equal(new Headers(init.headers).get("mcp-session-id"), "session-1");
    return rpc(init, {
      content: [{ type: "text", text: "done" }],
      structuredContent: { ok: true },
    });
  };
  const client = new RemoteMcpClient(connection(), undefined, request);
  assert.deepEqual(await client.listTools(), []);
  assert.deepEqual(await client.callTool("run", { value: 1 }), {
    content: [{ type: "text", text: "done" }],
    structuredContent: { ok: true },
  });
  await client.close();
  assert.deepEqual(methods, [
    "server/discover",
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
  ]);
});

test("[MCP-007BCE08] malformed tool declarations are isolated from valid tools", async () => {
  const request: typeof fetch = async (_input, init = {}) => {
    const body = JSON.parse(bodyText(init)) as { method: string };
    return body.method === "server/discover"
      ? rpc(init, { capabilities: { tools: {} } })
      : rpc(init, {
          tools: [
            { name: "bad", inputSchema: { type: "string" } },
            { name: "good", inputSchema: { type: "object" } },
          ],
        });
  };
  const catalog = await discoverRemoteMcp(connection(), undefined, request);
  assert.deepEqual(
    catalog.tools.map((tool) => tool.name),
    ["good"],
  );
  assert.match(catalog.diagnostics?.[0] ?? "", /bad.*object root/);
});

test("[MCP-007BCE08] catalog parsing bounds schemas, rejects duplicate names, and retains supported metadata", () => {
  const catalog = toolsFromListResult({
    tools: [
      {
        name: "full",
        title: "Full tool",
        description: "Every supported field",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      { name: "duplicate", inputSchema: { type: "object" } },
      { name: "duplicate", inputSchema: { type: "object" } },
      { name: "duplicate", inputSchema: { type: "object" } },
      { inputSchema: { type: "object" } },
      {
        name: "huge",
        inputSchema: { type: "object", description: "x".repeat(100_001) },
      },
      null,
    ],
    nextCursor: "next",
  });
  assert.deepEqual(catalog.tools, [
    {
      name: "full",
      title: "Full tool",
      description: "Every supported field",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ]);
  assert.equal(catalog.nextCursor, "next");
  assert.equal(catalog.diagnostics.length, 5);
  assert.ok(catalog.diagnostics.every((value) => value.length <= 500));
});

test("[MCP-948B2522] protected-resource and authorization-server metadata configure MCP OAuth automatically", async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = inputUrl(input);
    urls.push(url);
    if (init.method === "POST")
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
        },
      });
    if (url.includes("oauth-protected-resource"))
      return Response.json({
        resource: "https://mcp.test/mcp",
        authorization_servers: ["https://login.test/tenant"],
        scopes_supported: ["mcp.read", "mcp.write"],
      });
    return Response.json({
      issuer: "https://login.test/tenant",
      authorization_endpoint: "https://login.test/authorize",
      token_endpoint: "https://login.test/token",
      registration_endpoint: "https://login.test/register",
    });
  };
  const discovered = await discoverMcpAuthorization(connection(), request);
  assert.deepEqual(discovered, {
    ...connection(),
    auth: "oauth",
    authorizationUrl: "https://login.test/authorize",
    tokenUrl: "https://login.test/token",
    registrationUrl: "https://login.test/register",
    scopes: ["mcp.read", "mcp.write"],
    oauthIssuer: "https://login.test/tenant",
    oauthResource: "https://mcp.test/mcp",
  });
  assert.deepEqual(urls, [
    "https://mcp.test/mcp",
    "https://mcp.test/.well-known/oauth-protected-resource/mcp",
    "https://login.test/.well-known/oauth-authorization-server/tenant",
  ]);
});

test("[MCP-DB6BD516] legacy HTTP+SSE servers publish an endpoint and carry sessionful MCP messages", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder(),
    request: typeof fetch = async (input, init = {}) => {
      if (!init.method) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(
                encoder.encode("event: endpoint\ndata: /messages\n\n"),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      assert.equal(inputUrl(input), "https://mcp.test/messages");
      const body = JSON.parse(bodyText(init)) as {
        id?: string;
        method: string;
      };
      if (body.id) {
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: "legacy", version: "1" },
              }
            : { tools: [] };
        stream!.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
          ),
        );
      }
      return new Response(null, { status: 202 });
    };
  const legacy = validateConnection({
      name: "legacy",
      kind: "mcp",
      url: "https://mcp.test/sse",
      auth: "none",
      transport: "sse",
    }),
    client = new RemoteMcpClient(legacy, undefined, request);
  assert.deepEqual(await client.listTools(), []);
  await client.close();
});
