import assert from "node:assert/strict";
import test from "node:test";
import { validateConnection } from "../src/connections.ts";
import {
  discoverMcpAuthorization,
  discoverRemoteMcp,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SESSION_PROTOCOL_VERSION,
  McpCatalogRegistry,
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

/* @covers MCP-DB6BD516
Given an active remote MCP connection
	When integral opens communication with its server
		Then integral supports the MCP `2026-07-28` stateless HTTP protocol
			And supports the sessionful `2025-11-25` protocol family
			And supports the legacy `2024-11-05` HTTP+SSE transport
			And selects the newest mutually supported protocol
			And sends the protocol, routing, client identity, capability, and session metadata required by the selected version
			And follows the selected version's request, response, cancellation, and shutdown lifecycle
	When a sessionful server assigns an MCP session identifier
		Then integral returns that identifier only to the same connection and server boundary
			And reinitializes after the server expires the session
			And attempts orderly session termination when the Pi session ends
	When a server cannot negotiate any supported version
		Then integral marks that connection unavailable
			And does not send a tool request using guessed protocol semantics
*/
/* @covers MCP-007BCE08
Given an active MCP server advertises one or more tools
	When integral prepares a Pi session
		Then integral reads every page of the server's tool catalog
			And registers one Pi tool for each valid remote tool
			And preserves the remote tool's name when making MCP requests
			And gives the Pi tool a deterministic name namespaced by connection
			And exposes the remote title, description, input schema, output schema, and annotations supported by Pi
			And supports JSON Schema 2020-12 input schemas within documented resource limits
			And prevents one connection's names from colliding with Integral tools or another connection's tools
			And does not expose a generic `mcp_<server>` tool that requires Pi to guess a remote tool name
	When a remote tool declaration is malformed, duplicated, or exceeds a documented schema limit
		Then integral excludes that tool
			And reports a bounded diagnostic identifying its connection and tool
			And keeps other valid tools from the same server available
*/
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

/* @covers MCP-5751370A
Given an active MCP server changes its tool catalog
	When the negotiated protocol announces a tool-list change
		Or the advertised tool-catalog cache lifetime expires
		Or integral provisions a new Pi session after reconnecting
		Then integral retrieves the complete current catalog
			And validates it before replacing the previous catalog
			And makes the replacement catalog visible no later than the next Pi turn
			And lets an invocation already in flight finish against its original catalog
			And removes tools no longer advertised
			And adds newly advertised tools without requiring the user to remove and re-add the connection
	When catalog refresh fails
		Then integral retains no newly received partial catalog
			And reports the connection as degraded
			And does not prevent unrelated connections from operating
*/
test("[MCP-5751370A] catalog refresh atomically replaces complete catalogs on expiry, notification, and reconnect", async () => {
  let now = 0,
    calls = 0,
    fail = false;
  const discover: typeof discoverRemoteMcp = async (selected) => {
      calls++;
      if (fail) throw new Error("discovery failed");
      return {
        connection: selected,
        protocolVersion: MCP_PROTOCOL_VERSION,
        tools: [
          {
            name: calls === 1 ? "old" : "new",
            inputSchema: { type: "object" },
          },
        ],
      };
    },
    registry = new McpCatalogRegistry(discover, () => now, 100);
  assert.deepEqual(
    (await registry.refresh(connection(), undefined)).tools.map(
      (tool) => tool.name,
    ),
    ["old"],
  );
  assert.equal(calls, 1);
  assert.equal(
    (await registry.refresh(connection(), undefined)).tools[0]?.name,
    "old",
  );
  now = 101;
  assert.equal(
    (await registry.refresh(connection(), undefined)).tools[0]?.name,
    "new",
  );
  registry.announceToolListChange("docs");
  fail = true;
  await assert.rejects(
    registry.refresh(connection(), undefined),
    /discovery failed/,
  );
  assert.equal(registry.current("docs")?.tools[0]?.name, "new");
  fail = false;
  await registry.refresh(connection(), undefined, fetch, true);
  assert.equal(calls, 4);
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

/* @covers MCP-948B2522
Given a remote MCP server responds that authorization is required
	When integral adds or reconnects the server
		Then integral discovers its protected-resource metadata
			And discovers and validates the authorization server metadata
			And binds discovered client registration and tokens to that authorization-server issuer
			And prefers configured client information when supplied
			And otherwise uses a supported MCP client-registration mechanism
			And uses authorization code with PKCE
			And includes the MCP resource indicator in authorization and token requests
			And requests only the scopes advertised as necessary for the MCP resource
			And validates authorization state, issuer, redirect URI, and resource binding
			And accepts a loopback callback or a pasted authorization response
			And stores client credentials, access tokens, and refresh tokens only in the host credential area
			And never places a real credential in a Pi environment, file, argument, tool declaration, or MCP payload
	When an access token is near expiry
		Then integral refreshes it before the next MCP request
			And atomically stores the replacement token record
	When authorization discovery is incomplete or inconsistent
		Then integral refuses the connection
			And identifies the incompatible metadata without exposing secrets
*/
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
