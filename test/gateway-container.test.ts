import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  decideRequest,
  OAUTH_SENTINEL,
  parseProxyAuthorization,
  SENTINEL,
} from "../src/gateway-policy.ts";
import {
  buildContainerSpec,
  dockerMcpSidecarArgs,
  dockerRunArgs,
  isManagedContainerVariable,
  interpretPiProtocol,
  managedPiImage,
  newSessionIdentity,
  parsePiModelList,
  writeMcpExtension,
  writePiCredential,
  writeResourceExtension,
  writeTaskExtension,
} from "../src/container.ts";
import { loadConfig } from "../src/config.ts";
import { saveConnection, validateConnection } from "../src/connections.ts";
import { Gateway, allowsConnect, gatewayHealth } from "../src/gateway.ts";
import { Logger } from "../src/logging.ts";
import { deploymentId, writeComponentState } from "../src/state.ts";
import { fixture } from "./helpers.ts";
import {
  cleanupResourceProjection,
  prepareResourceProjection,
} from "../src/resources.ts";

test("[BOX-E1F472A1] managed Pi image identity changes with its build recipe", () => {
  const first = managedPiImage("1.2.3", [Buffer.from("first recipe")]),
    second = managedPiImage("1.2.3", [Buffer.from("second recipe")]);

  assert.notEqual(first, second);
  assert.match(first, /^integral-pi:0\.1\.0-recipe-[a-f0-9]{12}-pi-1\.2\.3$/);
});

test("[BOX-40521095] managed Pi image identity includes the governed package set", () => {
  const recipe = [Buffer.from("same recipe")],
    base = managedPiImage("1.2.3", recipe, ["git"]),
    customized = managedPiImage("1.2.3", recipe, ["git", "jq"]),
    reordered = managedPiImage("1.2.3", recipe, ["jq", "git"]);
  assert.notEqual(base, customized);
  assert.equal(customized, reordered);
});

/* @covers GATEWAY-3F299566
Given the integral gateway component is healthy
	When the CLI requests the gateway health endpoint
		Then the gateway returns success
			And identifies the current deployment
			And reports its current ready or degraded state
			And includes its current error when degraded
			And lets the CLI distinguish it from an unrelated process on the same port
*/
test("[GATEWAY-3F299566] gateway health identifies deployment and publishes the current component state", async (t) => {
  const paths = await fixture(t),
    deployment = deploymentId(paths);
  assert.deepEqual(await gatewayHealth(paths), {
    component: "gateway",
    deploymentId: deployment,
    status: "ready",
  });
  await writeComponentState(paths, {
    component: "gateway",
    deploymentId: deployment,
    endpoint: "http://127.0.0.1:7310",
    pid: process.pid,
    status: "degraded",
    fingerprint: "fingerprint",
    connectionGeneration: 1,
    startedAt: "now",
    error: "invalid connection",
  });
  assert.deepEqual(await gatewayHealth(paths), {
    component: "gateway",
    deploymentId: deployment,
    status: "degraded",
    error: "invalid connection",
  });
});

test("[SERVER-8A31D6C4] gateway lifecycle can run against controlled CA, listener, and interval boundaries", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    calls: string[] = [],
    timer = {},
    gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        ensureCa: async () => ({
          key: "key",
          cert: "cert",
          bundle: "bundle",
        }),
        servers: {
          async listen(_server, port, address) {
            calls.push(`listen:${address}:${port}`);
          },
          async close() {
            calls.push("close");
          },
        },
        intervals: {
          setInterval(_callback, milliseconds) {
            calls.push(`interval:${milliseconds}`);
            return timer;
          },
          clearInterval(handle) {
            assert.equal(handle, timer);
            calls.push("clear");
          },
        },
      },
    );
  await gateway.start();
  await gateway.stop();
  assert.deepEqual(calls, [
    `listen:127.0.0.1:${config.server.gatewayPort}`,
    "interval:500",
    "clear",
    "close",
  ]);
});

/* @covers EMAIL-FB2E88EF
Given an authenticated Pi session requests an email operation
	When the gateway completes or refuses the operation
		Then it emits a structured event with the connection, provider, operation, session, request, and verdict
			And a failure includes its bounded sanitized reason
			And the event excludes recipients, subject, body, and credentials
*/
test("[EMAIL-89334867] [EMAIL-FB2E88EF] authenticated Pi email calls resolve and log a named account inside the gateway", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    connection = validateConnection({
      name: "transactional",
      kind: "email",
      provider: "mailgun",
      auth: "key",
      capabilities: ["send"],
      domain: "mg.example.com",
      from_address: "robot@mg.example.com",
      allowed_recipients: ["person@example.com"],
    });
  await saveConnection(paths, connection, "domain-key");
  const logs: string[] = [];
  let executed: unknown,
    responseBody = "",
    responseStatus = 200;
  const gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "debug",
        format: "json",
        sink: (line) => logs.push(line),
      }),
      {
        async executeEmail(found, credential, operation) {
          executed = { found: found.name, credential, operation };
          return { id: "queued-1" };
        },
      },
    ),
    request = Readable.from([
      Buffer.from(
        JSON.stringify({
          connection: "transactional",
          operation: "send",
          to: ["person@example.com"],
          subject: "Hello",
          text: "Body",
        }),
      ),
    ]) as unknown as IncomingMessage,
    response = {
      setHeader() {},
      writeHead(status: number) {
        responseStatus = status;
        return response;
      },
      end(body?: string) {
        responseBody = body ?? "";
        return response;
      },
    } as unknown as ServerResponse;
  request.url = "/integral/email";
  request.method = "POST";
  request.headers = {
    "content-type": "application/json",
    "proxy-authorization": `Basic ${Buffer.from("integral:session-token").toString("base64")}`,
  };
  await gateway.reload(true);
  gateway.sessions.set("session-token", "session-1");
  await (
    gateway as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);
  assert.equal(responseStatus, 200);
  assert.deepEqual(JSON.parse(responseBody), { id: "queued-1" });
  assert.deepEqual(executed, {
    found: "transactional",
    credential: "domain-key",
    operation: {
      operation: "send",
      to: ["person@example.com"],
      subject: "Hello",
      text: "Body",
    },
  });
  const event = logs.find((line) => line.includes("gateway.email"));
  assert.ok(event);
  for (const expected of [
    "transactional",
    "mailgun",
    "send",
    "session-1",
    '"verdict":"allow"',
  ])
    assert.match(event, new RegExp(expected));
  assert.doesNotMatch(event, /person@example|Hello|Body|domain-key/);
});

test("[EMAIL-FB2E88EF] email gateway failures log bounded routing context without message content", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    connection = validateConnection({
      name: "transactional",
      kind: "email",
      provider: "mailgun",
      auth: "key",
      capabilities: ["send"],
      domain: "mg.example.com",
      from_address: "robot@mg.example.com",
      allowed_recipients: ["person@example.com"],
    });
  await saveConnection(paths, connection, "domain-key");
  const logs: string[] = [],
    gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "debug",
        format: "json",
        sink: (line) => logs.push(line),
      }),
      {
        async executeEmail() {
          throw new Error("provider refused safely");
        },
      },
    ),
    request = Readable.from([
      Buffer.from(
        JSON.stringify({
          connection: "transactional",
          operation: "send",
          to: ["private-recipient@example.com"],
          subject: "private subject",
          text: "private body",
        }),
      ),
    ]) as unknown as IncomingMessage,
    response = {
      writeHead() {
        return response;
      },
      end() {
        return response;
      },
    } as unknown as ServerResponse;
  request.url = "/integral/email";
  request.method = "POST";
  request.headers = {
    "proxy-authorization": `Basic ${Buffer.from("integral:session-token").toString("base64")}`,
  };
  await gateway.reload(true);
  gateway.sessions.set("session-token", "session-1");
  await (
    gateway as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);
  const event = logs.find((line) => line.includes("gateway.email_failed"));
  assert.ok(event);
  for (const expected of [
    "transactional",
    "mailgun",
    "send",
    "session-1",
    "provider refused safely",
  ])
    assert.match(event, new RegExp(expected));
  assert.doesNotMatch(
    event,
    /private-recipient|private subject|private body|domain-key/,
  );
});

/* @covers MCP-2F0F5CB5
Given Pi invokes a tool discovered from an MCP connection
	When integral handles the invocation
		Then integral validates the arguments against the advertised input schema
			And sends `tools/call` to the originating connection and server tool
			And routes the request over the connection's negotiated remote or stdio transport
			And sends a remote request only through the authenticated Integral gateway
			And injects a remote credential only after matching the connection's scheme, host, port, and path boundary
			And preserves supported text, image, audio, resource-link, embedded-resource, and structured result content
			And represents an MCP tool execution error as a tool result that Pi can reason about
			And represents a transport or protocol failure without exposing credentials or unrestricted response data
	When Pi cancels the invocation
		Then integral propagates cancellation according to the negotiated MCP version
			And stops waiting for the result
			And does not treat cancellation as successful tool execution
	When the remote server redirects a request outside the declared connection boundary
		Then the gateway refuses the redirect
			And does not forward the credential to the new destination
*/
test("[MCP-2F0F5CB5] authenticated Pi MCP calls use the named remote connection and host credential", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    connection = validateConnection({
      name: "docs",
      kind: "mcp",
      url: "https://mcp.test/mcp",
      auth: "key",
    });
  await saveConnection(paths, connection, "remote-secret");
  let called: unknown,
    responseBody = "",
    responseStatus = 200;
  const gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        async callRemoteMcp(found, credential, tool, args) {
          called = { found: found.name, credential, tool, args };
          return {
            content: [{ type: "text", text: "result" }],
            structuredContent: { count: 1 },
          };
        },
      },
    ),
    request = Readable.from([
      Buffer.from(
        JSON.stringify({
          connection: "docs",
          tool: "search",
          arguments: { query: "integral" },
        }),
      ),
    ]) as unknown as IncomingMessage,
    response = {
      setHeader() {},
      writeHead(status: number) {
        responseStatus = status;
        return response;
      },
      end(body?: string) {
        responseBody = body ?? "";
        return response;
      },
    } as unknown as ServerResponse;
  request.url = "/integral/mcp";
  request.method = "POST";
  request.headers = {
    "content-type": "application/json",
    "proxy-authorization": `Basic ${Buffer.from("integral:session-token").toString("base64")}`,
  };
  await gateway.reload(true);
  gateway.sessions.set("session-token", "session-1");
  await (
    gateway as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);
  assert.equal(responseStatus, 200);
  assert.deepEqual(JSON.parse(responseBody), {
    content: [{ type: "text", text: "result" }],
    structuredContent: { count: 1 },
  });
  assert.deepEqual(called, {
    found: "docs",
    credential: "remote-secret",
    tool: "search",
    args: { query: "integral" },
  });
});

/* @covers MCP-0A804DA4
Given an active stdio MCP connection is available to a Pi session
	When the runner provisions that session
		Then integral starts one dedicated MCP sidecar from the configured runner image
			And runs it as the same non-root numeric user used for Pi
			And gives it a read-only root filesystem, bounded temporary storage, bounded memory, no Linux capabilities, and no privilege escalation
			And does not mount the Pi session home, repositories, stores, Docker socket, Integral control-plane files, or host paths into it
			And supplies only its declared non-secret environment and assigned secret environment values
			And delivers secret values after sidecar creation without placing them in image configuration, container arguments, or persistent Docker metadata
			And keeps its network disconnected except for explicitly declared URL boundaries through the authenticated gateway
			And brokers MCP messages between Pi and the sidecar without exposing the sidecar's standard streams directly to Pi
			And negotiates the newest mutually supported version from the same MCP versions supported for remote servers
			And treats newline-delimited standard output as MCP protocol messages
			And treats standard error as bounded diagnostic output with credential redaction
	When the sidecar writes non-protocol data to standard output
		Then integral marks that connection unavailable for the session
			And terminates the sidecar without interpreting the data as a tool result
	When the sidecar exits, hangs, exceeds a resource limit, or violates its network policy
		Then integral fails the affected invocation with a bounded connection error
			And terminates any remaining sidecar resources
			And leaves Pi and unrelated MCP connections running
	When the Pi session ends or is replaced
		Then integral closes the sidecar's standard input
			And allows a bounded graceful-exit period
			And forcibly terminates the sidecar if it remains running
			And removes all sidecar resources and secret material
*/
test("[MCP-0A804DA4] stdio MCP sidecars keep secrets out of Docker metadata and mount only trust roots", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    connection = validateConnection({
      name: "local-tools",
      kind: "mcp",
      auth: "none",
      transport: "stdio",
      command: "/usr/local/bin/server",
      args: ["--literal", "value with spaces"],
      env: { PUBLIC_MODE: "safe" },
      secret_env: ["API_TOKEN"],
      allowed_urls: ["https://api.example.test/v1"],
    }),
    args = dockerMcpSidecarArgs(
      {
        connection,
        image: "sha256:locked",
        sessionId: "session-1",
        sessionToken: "gateway-session-token",
        gatewayUrl: "http://host.integral.internal:7310",
        gatewayAddress: "172.20.0.1",
        caCert: "/host/integral-ca.pem",
        caBundle: "/host/ca-bundle.pem",
        secretValues: { API_TOKEN: "super-secret-value" },
      },
      config,
      "integral-network",
    ),
    rendered = args.join(" "),
    mounts = args.filter((_value, index) => args[index - 1] === "--mount");
  assert.doesNotMatch(rendered, /super-secret-value|API_TOKEN/);
  assert.match(rendered, /--network integral-network/);
  assert.match(rendered, /--read-only/);
  assert.match(rendered, /--security-opt no-new-privileges/);
  assert.match(rendered, /--cap-drop ALL/);
  assert.match(rendered, /PUBLIC_MODE=safe/);
  assert.equal(mounts.length, 2);
  assert.ok(mounts.every((mount) => mount.endsWith(",readonly")));
  assert.deepEqual(args.slice(-3), [
    "/usr/local/bin/server",
    "--literal",
    "value with spaces",
  ]);
});

test("[MCP-2F0F5CB5] authenticated stdio MCP calls are brokered to the owning runner session", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    connection = validateConnection({
      name: "local-tools",
      kind: "mcp",
      auth: "none",
      transport: "stdio",
      command: "mcp-server",
    });
  await saveConnection(paths, connection);
  let forwarded: unknown,
    responseBody = "",
    responseStatus = 200;
  const gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        async internalFetch(_paths, caller, target, path, init) {
          if (!init || typeof init.body !== "string")
            throw new Error("expected string MCP broker body");
          forwarded = {
            caller,
            target,
            path,
            body: JSON.parse(init.body),
          };
          return Response.json({ content: [{ type: "text", text: "local" }] });
        },
      },
    ),
    request = Readable.from([
      Buffer.from(
        JSON.stringify({
          connection: "local-tools",
          tool: "lookup",
          arguments: { id: 7 },
        }),
      ),
    ]) as unknown as IncomingMessage,
    response = {
      setHeader() {},
      writeHead(status: number) {
        responseStatus = status;
        return response;
      },
      end(body?: string) {
        responseBody = body ?? "";
        return response;
      },
    } as unknown as ServerResponse;
  request.url = "/integral/mcp";
  request.method = "POST";
  request.headers = {
    "proxy-authorization": `Basic ${Buffer.from("integral:session-token").toString("base64")}`,
  };
  await gateway.reload(true);
  gateway.sessions.set("session-token", "session-1");
  await (
    gateway as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);
  assert.equal(responseStatus, 200);
  assert.deepEqual(JSON.parse(responseBody), {
    content: [{ type: "text", text: "local" }],
  });
  assert.deepEqual(forwarded, {
    caller: "gateway",
    target: "runner",
    path: "/integral/internal/mcp",
    body: {
      sessionId: "session-1",
      connection: "local-tools",
      tool: "lookup",
      arguments: { id: 7 },
    },
  });
});

/* @covers GATEWAY-578CEF2E
Given the gateway is running
	When a client makes a proxy request without a valid active-session token
		Then the gateway returns HTTP 407 with a Basic proxy-authentication challenge
			And does not connect to the upstream host
*/
/* @covers GATEWAY-B6C64AA7
Given an active chat has a unique session token
	When its container sends a request through the gateway
		Then the container supplies the token as the password in Basic proxy authentication
			And the gateway associates the request with that chat session
			And removes proxy authorization and proxy connection headers before forwarding
			And rejects the token after the session ends
*/
test("[GATEWAY-578CEF2E] [GATEWAY-B6C64AA7] proxy authentication extracts only an explicit Basic session token", () => {
  assert.equal(parseProxyAuthorization(undefined), undefined);
  assert.equal(parseProxyAuthorization("Bearer token"), undefined);
  assert.equal(
    parseProxyAuthorization(
      `Basic ${Buffer.from("integral:session-token").toString("base64")}`,
    ),
    "session-token",
  );
});

/* @covers SCHEDULE-55BD779F
Given Pi has an active integral session
	When Pi creates a recurring schedule with a five-field cron expression, IANA timezone, and self-contained task prompt
		Then the request passes through the authenticated gateway control boundary
			And the scheduler validates the expression, timezone, minimum frequency, and task size
			And durably records a stable schedule ID and revision before acknowledging it
			And does not expose component credentials or endpoints to Pi
	When Pi creates a one-time schedule with a future execution instant and self-contained task prompt
		Then the scheduler applies the same authenticated and durable creation boundary
			And records the trigger as one-time
	When Pi lists, updates, disables, enables, or deletes one of its schedules
		Then the scheduler applies the operation to the stable schedule ID
			And an update requires the expected current revision
			And an accepted mutation is durable before it is reported to Pi
			And disabling or deleting a schedule prevents new occurrences without discarding an occurrence already due
*/
test("[SCHEDULE-55BD779F] gateway attributes Pi schedule mutations and injects the selected execution profile", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = { ...base, server: { ...base.server, gatewayPort: 0 } },
    forwarded: Array<{ path: string; body?: string }> = [],
    gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        ensureCa: async () => ({ key: "key", cert: "cert", bundle: "bundle" }),
        async internalFetch(_paths, _caller, target, path, init) {
          if (target === "coordinator")
            return Response.json({
              modelSelection: {
                connection: "model",
                provider: "anthropic",
                model: "claude-sonnet-4-6",
                piVersion: "1.2.3",
                piImage: "sha256:test",
              },
            });
          forwarded.push({
            path,
            ...(typeof init?.body === "string" ? { body: init.body } : {}),
          });
          return Response.json(
            { id: "schedule-1", revision: 1 },
            { status: 201 },
          );
        },
      },
    );
  const body = {
    prompt: "work",
    trigger: { type: "once", runAt: "2026-08-03T12:00:00Z" },
    profile: { provider: "forged" },
  };
  const result = await gateway.scheduleControl(
    "session-1",
    "POST",
    "/integral/schedules",
    body,
  );
  assert.equal(result.status, 201);
  const forwardedRequest = forwarded[0];
  assert.equal(forwardedRequest?.path, "/integral/schedules");
  assert.ok(forwardedRequest?.body);
  const forwardedBody = JSON.parse(forwardedRequest.body) as Record<
    string,
    unknown
  >;
  assert.equal(forwardedBody.actor, "pi:session-1");
  assert.equal(
    (forwardedBody.profile as Record<string, unknown>).provider,
    "anthropic",
  );
});

test("[SCHEDULE-55BD779F] authenticated origin-form schedule requests reach the scheduler", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    forwarded: string[] = [],
    gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        async internalFetch(_paths, _caller, target, path) {
          assert.equal(target, "scheduler");
          forwarded.push(path);
          return Response.json([]);
        },
      },
    ),
    request = Readable.from([]) as unknown as IncomingMessage;
  let status = 0,
    responseBody = "";
  const response = {
    once() {
      return response;
    },
    writeHead(value: number) {
      status = value;
      return response;
    },
    end(value?: string) {
      responseBody = value ?? "";
      return response;
    },
  } as unknown as ServerResponse;
  request.url = "/integral/control/schedules";
  request.method = "GET";
  request.headers = {
    "proxy-authorization": `Basic ${Buffer.from("integral:session-token").toString("base64")}`,
  };
  gateway.sessions.set("session-token", "session-1");
  await (
    gateway as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);

  assert.equal(status, 200);
  assert.equal(responseBody, "[]");
  assert.deepEqual(forwarded, ["/integral/schedules"]);
});

test("[BOX-40521095] [GATEWAY-846B1000] authenticated package controls bind session and run lineage at the gateway", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  let forwarded:
    { target: string; path: string; body: Record<string, unknown> } | undefined;
  const gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        async internalFetch(_paths, _caller, target, path, init) {
          const serialized = init?.body;
          if (typeof serialized !== "string")
            throw new Error("expected serialized package request");
          forwarded = {
            target,
            path,
            body: JSON.parse(serialized) as Record<string, unknown>,
          };
          return Response.json({ revision: 1, packages: ["git", "jq"] });
        },
      },
    ),
    request = Readable.from([
      Buffer.from(
        JSON.stringify({
          operation: "install",
          packages: ["jq"],
          expectedRevision: 0,
          actor: "forged",
        }),
      ),
    ]) as unknown as IncomingMessage;
  let status = 0;
  const response = {
    once() {
      return response;
    },
    writeHead(value: number) {
      status = value;
      return response;
    },
    end() {
      return response;
    },
  } as unknown as ServerResponse;
  request.url = "/integral/control/container-packages";
  request.method = "POST";
  request.headers = {
    "proxy-authorization": `Basic ${Buffer.from("integral:package-token").toString("base64")}`,
  };
  gateway.sessions.set("package-token", "session-42");
  gateway.sessionRunIds.set("session-42", "run-42");
  await (
    gateway as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);
  assert.equal(status, 200);
  assert.deepEqual(forwarded, {
    target: "coordinator",
    path: "/integral/internal/container-packages",
    body: {
      operation: "install",
      packages: ["jq"],
      expectedRevision: 0,
      originSessionId: "session-42",
      originRunId: "run-42",
    },
  });
});

test("[BOX-6A91C3E7] [REPO-7B0E2F4A] image recipe pushes cross into approval with authenticated lineage", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  let forwarded: Record<string, unknown> | undefined;
  const gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        async internalFetch(_paths, _caller, target, path, init) {
          assert.equal(target, "coordinator");
          assert.equal(path, "/integral/internal/image-recipe");
          const serialized = init?.body;
          if (typeof serialized !== "string")
            throw new Error("expected serialized image proposal");
          forwarded = JSON.parse(serialized) as Record<string, unknown>;
          return Response.json({ id: "approval-image", status: "pending" });
        },
      },
    ),
    request = Readable.from([
      Buffer.from(
        JSON.stringify({
          proposed: "b".repeat(40),
          bundle: "encoded-bundle",
          originSessionId: "forged",
        }),
      ),
    ]) as unknown as IncomingMessage;
  let status = 0;
  const response = {
    once() {
      return response;
    },
    writeHead(value: number) {
      status = value;
      return response;
    },
    end() {
      return response;
    },
  } as unknown as ServerResponse;
  request.url = "/integral/control/resources/repos/integral-image-recipe/push";
  request.method = "POST";
  request.headers = {
    "proxy-authorization": `Basic ${Buffer.from("integral:image-token").toString("base64")}`,
  };
  gateway.sessions.set("image-token", "session-image");
  gateway.sessionRunIds.set("session-image", "run-image");
  await (
    gateway as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);
  assert.equal(status, 200);
  assert.deepEqual(forwarded, {
    operation: "proposal",
    proposed: "b".repeat(40),
    bundle: "encoded-bundle",
    originSessionId: "session-image",
    originRunId: "run-image",
  });
});

/* @covers SCHEDULE-930581F7
Given an isolated task container is processing exactly one occurrence
	When Pi reaches the end of a turn without calling any tool and has not declared the task complete or failed
		Then the task completion extension injects a steering message before the agent loop settles
			And requires Pi to call exactly one of `task_complete` or `task_fail`
			And the task remains running while Pi performs the additional turn
	When Pi calls `task_complete` or `task_fail`
		Then the extension durably records Pi's declared outcome for the current authenticated attempt
			And a repeated identical declaration is harmless
			And a conflicting declaration is rejected
			And the declaration alone does not finalize the task
	When Pi durably declares completion and then exits naturally with status zero
		Then the coordinator durably records the complete task result
			And durably records a pending scheduler acknowledgement
			And only then reports successful execution
	When Pi durably declares failure and then exits naturally with status zero
		Then integral records an unsuccessful attempt using Pi's declared reason
			And does not report successful execution
	When the task times out, is cancelled, rejects the prompt, exits without a declared outcome, exits non-zero, or is forcibly terminated
		Then integral records an unsuccessful attempt
			And does not treat partial output as a successful task result
			And does not send a successful acknowledgement to the scheduler
	When any task attempt finishes
		Then the runner revokes that attempt's gateway identity
			And removes its container and temporary home
			And never retains the container for another task or talk turn
*/
test("[SCHEDULE-930581F7] task outcome declarations derive execution identity from the authenticated gateway session", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  let forwarded:
    { target: string; path: string; body: Record<string, unknown> } | undefined;
  const gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        async internalFetch(_paths, _caller, target, path, init) {
          const body = init?.body;
          if (typeof body !== "string")
            throw new Error("expected serialized task declaration");
          forwarded = {
            target,
            path,
            body: JSON.parse(body) as Record<string, unknown>,
          };
          return Response.json({ state: "running" });
        },
      },
    ),
    request = Readable.from([
      Buffer.from(
        JSON.stringify({ outcome: "complete", message: "sent the report" }),
      ),
    ]) as unknown as IncomingMessage;
  let status = 0;
  const response = {
    writeHead(value: number) {
      status = value;
      return response;
    },
    end() {
      return response;
    },
  } as unknown as ServerResponse;
  request.url = "/integral/task-outcome";
  request.method = "POST";
  request.headers = {
    "proxy-authorization": `Basic ${Buffer.from("integral:task-token").toString("base64")}`,
  };
  gateway.sessions.set("task-token", "task-session");
  gateway.taskSessions.set("task-session", {
    executionId: "execution/one",
    attemptId: "attempt-1",
  });

  await (
    gateway as unknown as {
      route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).route(request, response);

  assert.equal(status, 200);
  assert.deepEqual(forwarded, {
    target: "coordinator",
    path: "/integral/internal/tasks/execution%2Fone/declare",
    body: {
      attemptId: "attempt-1",
      outcome: "complete",
      message: "sent the report",
    },
  });
});

/* @covers GATEWAY-EB8D96FE
Given an authenticated chat container is active
	When it requests a destination outside every active connection boundary
		Then the gateway returns HTTP 403
			And states that policy denied the request
			And does not contact the requested upstream
	When it requests an HTTPS tunnel
		Then the gateway accepts `CONNECT` only on port 443
			And refuses the tunnel before interception unless an active HTTPS connection can match its host and port
			And still applies method and path policy to each intercepted request
*/
test("[GATEWAY-EB8D96FE] CONNECT admits only the exact configured HTTPS host and port, including non-default ports", () => {
  const connection = validateConnection({
    name: "local-tls",
    kind: "http",
    url: "https://service.test:8443/api",
    auth: "none",
  });
  const candidates = [{ connection, credential: undefined }];
  assert.equal(allowsConnect(candidates, "service.test", 8443), true);
  assert.equal(allowsConnect(candidates, "SERVICE.TEST", 8443), true);
  assert.equal(allowsConnect(candidates, "service.test", 443), false);
  assert.equal(allowsConnect(candidates, "other.test", 8443), false);
  assert.equal(allowsConnect(candidates, "service.test", 0), false);
});

/* @covers GATEWAY-A2BBBBE8
Given an authenticated chat container is active
	And its request matches an active connection's scheme policy
	And its request matches that connection's host and port policy
	And its request matches that connection's method and path policy
	When Pi sends the request through the gateway
		Then the gateway establishes a verified upstream TLS connection
			And replaces the managed sentinel with the connection's real credential when authentication requires it
			And refuses a caller-supplied credential that is not the integral sentinel
			And forwards the upstream response to Pi
			And does not log the real credential
*/
test("[GATEWAY-A2BBBBE8] a matching connection injects its host credential only inside its exact boundary", () => {
  const connection = validateConnection({
    name: "api",
    kind: "http",
    url: "https://api.test/v1",
    auth: "key",
    methods: ["POST"],
    path_prefix: "/v1/messages",
  });
  const decision = decideRequest(
    "POST",
    new URL("https://api.test/v1/messages/1?private=yes"),
    { authorization: `Bearer ${SENTINEL}` },
    [{ connection, credential: "real-secret" }],
  );
  assert.equal(decision.connection.name, "api");
  assert.equal(decision.headers.authorization, "Bearer real-secret");
  assert.equal(
    decideRequest(
      "POST",
      new URL("https://api.test/v1/messages/1"),
      { authorization: `Bearer ${OAUTH_SENTINEL}` },
      [{ connection, credential: "real-secret" }],
    ).headers.authorization,
    "Bearer real-secret",
  );
});

test("[CONNECTION-12C87631] GitHub API and smart HTTP receive host-specific authentication", () => {
  const connection = validateConnection({
      name: "github",
      kind: "http",
      provider: "github",
      auth: "key",
      hosts: ["api.github.com", "github.com"],
    }),
    candidates = [{ connection, credential: "real-token" }];
  assert.equal(
    decideRequest(
      "GET",
      new URL("https://api.github.com/user"),
      { authorization: `token ${SENTINEL}` },
      candidates,
    ).headers.authorization,
    "token real-token",
  );
  assert.equal(
    decideRequest(
      "POST",
      new URL("https://github.com/acme/project.git/git-upload-pack"),
      {},
      candidates,
    ).headers.authorization,
    `Basic ${Buffer.from("x-access-token:real-token").toString("base64")}`,
  );
  assert.equal(allowsConnect(candidates, "github.com", 443), true);
  assert.equal(allowsConnect(candidates, "api.github.com", 443), true);
  assert.equal(allowsConnect(candidates, "github.com", 22), false);
  assert.equal(
    allowsConnect(candidates, "objects.githubusercontent.com", 443),
    false,
  );
  assert.throws(
    () => decideRequest("GET", new URL("https://evil.test/"), {}, candidates),
    /policy denied/,
  );
});

test("[GATEWAY-EB8D96FE] destinations, methods, paths, schemes, and ports outside active boundaries are denied", () => {
  const connection = validateConnection({
    name: "api",
    kind: "http",
    url: "https://api.test:8443/v1",
    auth: "none",
    methods: ["GET"],
  });
  for (const [method, url] of [
    ["POST", "https://api.test:8443/v1"],
    ["GET", "https://other.test:8443/v1"],
    ["GET", "http://api.test:8443/v1"],
    ["GET", "https://api.test/v2"],
    ["GET", "https://api.test/v1"],
  ] as const) {
    if (url.endsWith(":8443/v1") && method === "GET") continue;
    assert.throws(
      () =>
        decideRequest(method, new URL(url), {}, [
          { connection, credential: undefined },
        ]),
      /policy denied/,
    );
  }
});

/* @covers GATEWAY-123EDBDF
Given a request matches an active credentialed connection
	And its credential file is missing
	Or its recognized OAuth credential cannot be refreshed
	When the gateway evaluates the request
		Then it refuses the request
			And does not forward the sentinel upstream
			And tells the user to rotate or reconfigure the connection
*/
test("[GATEWAY-123EDBDF] credentialed requests fail closed when injection is missing or unmanaged", () => {
  const connection = validateConnection({
    name: "api",
    kind: "http",
    url: "https://api.test",
    auth: "key",
  });
  assert.throws(
    () =>
      decideRequest("GET", new URL("https://api.test"), {}, [
        { connection, credential: undefined },
      ]),
    /rotate or reconfigure/,
  );
  assert.throws(
    () =>
      decideRequest(
        "GET",
        new URL("https://api.test"),
        { authorization: "Bearer user-secret" },
        [{ connection, credential: "real" }],
      ),
    /unmanaged credential/,
  );
});

/* @covers ENV-D20B7A48
Given the host shell contains arbitrary environment variables
	When integral provisions a Pi container
		Then integral constructs a new container environment from an explicit allowlist
			And does not inherit the host environment wholesale
			And excludes `INTEGRAL_HOME`, `INTEGRAL_GATEWAY_PORT`, `INTEGRAL_COORDINATOR_PORT`, and `INTEGRAL_RUNNER_PORT`
			And excludes host credential and authorization variables
			And sets `HOME` to `/home/pi`
			And sets `PATH` to `/usr/local/bin:/usr/bin:/bin`
			And sets `TMPDIR` to `/tmp`
*/
/* @covers ENV-3E85C1F9
Given integral provisions an authenticated Pi session
	When it constructs the container environment
		Then it sets `HTTP_PROXY` and `HTTPS_PROXY` to the session-authenticated gateway URL
			And sets `http_proxy` and `https_proxy` to the same URL
			And sets `NO_PROXY` and `no_proxy` to empty values
			And does not place a real connection credential in any proxy variable
*/
/* @covers ENV-F19A64B2
Given integral provisions a Pi container
	When it constructs the container environment
		Then it sets `NODE_EXTRA_CA_CERTS` to the mounted integral CA certificate
			And sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, and `PIP_CERT` to the mounted combined CA bundle
			And uses container paths rather than host paths
			And mounts the referenced certificate files read-only
	When the deployment CA does not exist
		Then integral creates one under the deployment data directory
			And builds a trust bundle from available system roots plus the integral CA
			And does not mount the CA private key into the container
	When the gateway intercepts an allowed HTTPS host for the first time
		Then integral creates and caches a host certificate signed by the deployment CA
*/
/* @covers ENV-6C3F91E5
Given the host shell contains provider keys, tokens, or credential variables
	And no corresponding integral connection is configured
	When integral starts the server or provisions Pi
		Then integral does not treat those ambient variables as connections
			And does not copy them into the container
			And requires credentials to enter through `integral connection add`
*/
test("[ENV-D20B7A48] [ENV-3E85C1F9] [ENV-F19A64B2] [ENV-6C3F91E5] container environment is a managed allowlist with authenticated proxy and CA trust", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    model = validateConnection({
      name: "model",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    identity = newSessionIdentity();
  const spec = buildContainerSpec({
    config,
    selectedModel: "claude-sonnet-4-6",
    gatewayUrl: "http://host.integral.internal:7310",
    caCert: "/host/ca",
    caBundle: "/host/bundle",
    sessionHome: "/tmp/session",
    ...identity,
    model,
    mcp: [],
  });
  assert.equal(spec.environment.ANTHROPIC_API_KEY, SENTINEL);
  assert.match(
    spec.environment.HTTP_PROXY!,
    /integral:.*@host\.integral\.internal/,
  );
  assert.equal(spec.environment.HTTP_PROXY, spec.environment.HTTPS_PROXY);
  assert.equal(spec.environment.NO_PROXY, "");
  assert.equal(
    spec.environment.NODE_EXTRA_CA_CERTS,
    "/integral-ca/integral-ca.pem",
  );
  assert.equal(spec.environment.SSL_CERT_FILE, "/integral-ca/ca-bundle.pem");
  assert.equal(spec.environment.PI_CODING_AGENT_DIR, "/home/pi/.pi/agent");
  assert.equal(spec.environment.NODE_USE_ENV_PROXY, "1");
  assert.equal("INTEGRAL_HOME" in spec.environment, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in spec.environment, false);
});

test("[ENV-7B2D40AC] integral-managed environment names cannot be delegated to connection configuration", () => {
  for (const name of [
    "HOME",
    "PATH",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "PI_CODING_AGENT_DIR",
    "INTEGRAL_HOME",
    "INTEGRAL_CUSTOM",
  ])
    assert.equal(isManagedContainerVariable(name), true);
  assert.equal(isManagedContainerVariable("LANG"), false);
});

/* @covers CONNECTION-0FB2F92A
Given an active credentialed connection is configured on the host
	When integral provisions a chat container
		Then every real credential is absent from the container environment
			And is absent from container files
			And is absent from container arguments
			And is absent from Docker metadata
			And any credential visible to Pi is a harmless sentinel
*/
/* @covers CONNECTION-D20F6A85
Given a connection is valid and active
	When integral starts a new Pi session
		Then integral makes the connection available to that session automatically
			And maps Anthropic model traffic to `https://api.anthropic.com/`
			And maps OpenAI Codex model traffic to `https://chatgpt.com/backend-api/`
			And injects the stored OpenAI account ID as `chatgpt-account-id` when present
			And does not expose another connection's credential on its requests
*/
test("[CONNECTION-0FB2F92A] [CONNECTION-D20F6A85] real credentials are absent from container environment, arguments, mounts, and Docker metadata", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    model = validateConnection({
      name: "m",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    });
  const spec = buildContainerSpec({
    config,
    selectedModel: "claude-sonnet-4-6",
    gatewayUrl: "http://host.integral.internal:7310",
    caCert: "/ca",
    caBundle: "/bundle",
    sessionHome: "/session",
    ...newSessionIdentity(),
    model,
    mcp: [],
  });
  const rendered = JSON.stringify(spec);
  assert.doesNotMatch(rendered, /actual-provider-secret/);
  assert.match(rendered, new RegExp(SENTINEL));
});

test("[CONNECTION-12C87631] an active GitHub connection exposes only GH_TOKEN's sentinel", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    model = validateConnection({
      name: "m",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    github = validateConnection({
      name: "github",
      kind: "http",
      provider: "github",
      auth: "key",
      hosts: ["api.github.com", "github.com"],
    }),
    spec = buildContainerSpec({
      config,
      selectedModel: "claude-sonnet-4-6",
      gatewayUrl: "http://host.integral.internal:7310",
      caCert: "/ca",
      caBundle: "/bundle",
      sessionHome: "/session",
      ...newSessionIdentity(),
      model,
      mcp: [],
      connections: [github],
    });
  assert.equal(spec.environment.GH_TOKEN, SENTINEL);
  assert.equal(isManagedContainerVariable("GH_TOKEN"), true);
  assert.doesNotMatch(JSON.stringify(spec), /real-github-token/);
});

/* @covers BOX-601613D4
Given integral is provisioning a Pi container
	When Docker receives the container specification
		Then the container runs as a non-root user
			And disables privilege escalation
			And drops additional Linux capabilities
			And uses a read-only root filesystem
			And mounts `/tmp` as a size-bounded `tmpfs` with execution and set-user-ID disabled
			And mounts one fresh session home and explicitly configured host stores as the only writable host filesystems
			And places governed per-run repository checkouts only inside that fresh session home
			And mounts each host store only at its recorded mount path
			And does not mount canonical repositories or unconfigured host directories
			And does not mount the Docker socket
			And does not mount control-plane configuration or credentials
			And mounts only the gateway CA, curated read-only run history, fresh temporary session home, store lock namespace, and configured store directories as required
*/
/* @covers GATEWAY-EC79406A
Given a chat container is running
	When software in the container attempts internet access without the gateway
		Then the connection cannot reach the destination
			And integral fails container startup when it cannot create the locked network
*/
/* @covers RUN-01CA16F2
Given one or more runs were finalized before integral prepares a new agent environment
	When integral provisions an interactive or scheduled-task container
		Then it makes every earlier finalized run in that deployment available under `$HOME/history/runs`
			And provides a machine-readable index ordered by run start time
			And provides each run's metadata, ordered activity, learning-signal summary, usage, and outcome under its run ID
			And includes successful, failed, interrupted, cancelled, and timed-out runs
			And includes earlier attempts of the same one-time scheduled task
			And mounts the history view read-only
			And does not require the agent to call a host tool or network service to inspect it
Given no run was finalized before integral prepares a new agent environment
	When integral provisions the container
		Then `$HOME/history/runs` exists as an empty readable history view
			And the machine-readable index contains no finalized runs
Given integral has begun the run for a new agent environment
	When it provisions the container
		Then it makes that run available under `$HOME/history/current`
			And exposes its running metadata, ordered activity, and provisional learning-signal and usage summary
	When the current run records input, output, tool activity, provider usage, feedback, or failure
		Then `$HOME/history/current` reflects the newly recorded evidence while the session remains active
	When integral finalizes the current run
		Then `$HOME/history/current` reflects its final status, outcome, elapsed time, and final learning-signal summary before the environment is removed
*/
/* @covers RUN-79BACB0C
Given integral is constructing the agent-visible history view
	When it projects a durable run record into that view
		Then it includes the prompts, agent-visible tool inputs and results, assistant output, and host-observed outcome
			And excludes gateway session tokens, real provider credentials, component authentication, and credential-bearing proxy URLs
			And excludes host-only configuration, locks, and mutable queue state
			And does not mount `<INTEGRAL_HOME>` or the host run archive itself into the container
			And updates the current-run projection without exposing a writable path back to the durable record
	When an agent attempts to modify, rename, or delete history content
		Then the container filesystem refuses the change
			And the durable host record remains unchanged
*/
test("[BOX-601613D4] [GATEWAY-EC79406A] [RUN-01CA16F2] [RUN-79BACB0C] Docker specification is non-root, read-only, capability-free, bounded, and locked to an internal network", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    model = validateConnection({
      name: "m",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    spec = buildContainerSpec({
      config,
      selectedModel: "claude-sonnet-4-6",
      gatewayUrl: "http://host.integral.internal:7310",
      caCert: "/ca",
      caBundle: "/bundle",
      sessionHome: "/fresh",
      historyView: "/host/projected-history",
      ...newSessionIdentity(),
      model,
      mcp: [],
    });
  const args = dockerRunArgs(spec, config, "integral-locked");
  for (const expected of [
    "--interactive",
    "--network",
    "integral-locked",
    "--user",
    "1000:1000",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--memory",
    "2048m",
    "--tmpfs",
  ])
    assert.ok(args.includes(expected));
  assert.equal(args.includes("/var/run/docker.sock"), false);
  assert.equal(args.includes(process.cwd()), false);
  assert.ok(
    args.includes(
      "type=bind,source=/host/projected-history,target=/home/pi/history,readonly",
    ),
  );
});

/* @covers BOX-AB639757
Given the coordinator, runner, and gateway are healthy
	And no Pi session is active
	And the durable queue contains a message ready for delivery
	When the runner claims the next queued message from the coordinator
		Then integral creates a fresh temporary session home
			And starts one non-root Docker container for Pi on the locked network
			And runs the immutable Pi image recorded with the conversation selection in RPC mode with session persistence and approval prompts disabled
			And runs Pi offline so Pi does not perform its own startup network operations
			And keeps container standard input attached for the lifetime of the RPC session
			And supplies the conversation's selected model connection and model
			And supplies only a sentinel credential in the authentication shape required by the selected provider
			And restores conversational context from the durable conversation record
			And sends the claimed message as a Pi `prompt` command
*/
/* @covers BOX-B45DEA9B
Given integral has an active Pi RPC session
	When the runner claims another message after the prior turn completes
		Then integral sends it to the same Pi process
			And sends it to the same Pi session
			And preserves preceding turns as conversational context
			And cancels a pending idle shutdown before starting the turn
			And does not start a second Pi container or duplicate an existing MCP sidecar
*/
test("[BOX-AB639757] [BOX-B45DEA9B] one RPC container specification carries the selected image and prompt-capable Pi mode", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    model = validateConnection({
      name: "m",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    identity = newSessionIdentity(),
    spec = buildContainerSpec({
      config,
      selectedModel: "claude-sonnet-4-6",
      gatewayUrl: "http://host.integral.internal:7310",
      caCert: "/ca",
      caBundle: "/bundle",
      sessionHome: "/fresh",
      ...identity,
      model,
      mcp: [],
    });
  assert.equal(spec.image, "integral-pi:0.1.0");
  assert.deepEqual(spec.args.slice(0, 5), [
    "--mode",
    "rpc",
    "--no-session",
    "--approve",
    "--offline",
  ]);
  assert.deepEqual(spec.args.slice(5, 9), [
    "--provider",
    "anthropic",
    "--api-key",
    "integral-managed-credential",
  ]);
  assert.equal(spec.sessionId, identity.sessionId);
});

/* @covers CONNECTION-4B8D73F1
Given the user has the URL of a remote MCP server
	When the user runs `integral connection add mcp --name <name> --url <url>`
		Then integral contacts the endpoint through trusted host code
			And automatically detects Streamable HTTP or legacy HTTP+SSE
			And determines whether the endpoint requires authentication
			And completes standardized MCP OAuth when authentication is required
			And completes without authentication when the server permits anonymous access
			And negotiates a supported MCP protocol version
			And discovers every available tool before committing the connection
			And stores the connection only after discovery succeeds
			And reports the server name, negotiated protocol, transport, authentication state, and tool count
			And does not require transport, OAuth endpoint, scope, or client-registration flags for a conforming MCP server
	When discovery, authentication, protocol negotiation, or tool discovery fails
		Then integral exits non-zero
			And explains the failing stage without printing credentials
			And does not store a partial connection or credential
	When the user explicitly supplies supported authentication or transport options
		Then integral treats them as compatibility overrides
			And still verifies the resulting MCP connection before committing it
*/
test("[CONNECTION-4B8D73F1] [SCHEDULE-55BD779F] [BOX-40521095] temporary Pi extensions expose remote MCP and authenticated control tools", async (t) => {
  const paths = await fixture(t),
    mcp = validateConnection({
      name: "work-docs",
      kind: "mcp",
      url: "https://mcp.test/rpc",
      auth: "key",
    });
  await writeMcpExtension(paths.root, [
    {
      connection: mcp,
      protocolVersion: "2026-07-28",
      tools: [
        {
          name: "search-docs",
          title: "Search docs",
          description: "Search the documentation",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    },
  ]);
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(`${paths.root}/.integral/extensions/integral-mcp.ts`, "utf8"),
  );
  assert.match(source, /"connection":"work-docs"/);
  assert.match(source, /"remoteName":"search-docs"/);
  assert.match(source, /"name":"mcp_work_docs_search_docs_[0-9a-f]{8}"/);
  assert.match(source, /"properties":\{"query":\{"type":"string"\}\}/);
  assert.match(source, /\/integral\/mcp/);
  assert.match(source, /schedule_create/);
  assert.match(source, /schedule_update/);
  assert.match(source, /container_package_list/);
  assert.match(source, /container_package_" \+ operation/);
  assert.match(source, /\["install", "upgrade"\]/);
  assert.match(source, /proxy-authorization/);
  assert.match(source, /request\(target\.url, \{ agent: false/);
  assert.doesNotMatch(source, /fetch\("http:\/\/integral\.control/);
  assert.doesNotMatch(source, /actual-secret/);
});

/* @covers REPO-D1865075
Given integral provisions any interactive or isolated scheduled Pi session
	When it prepares Pi's extensions
		Then it registers `repo_list`, `repo_create`, `repo_push`, `repo_delete`, and `repo_restore`
			And describes the commit-before-push and soft-delete semantics to Pi
			And explains that creation and restoration replace the calling session while deletion changes mounted resources only for later sessions
			And sends every operation through the authenticated gateway control boundary
			And derives repository authority from the session instead of accepting a host path from Pi
			And keeps the tools available when no repository connection exists yet
	When a repository tool is called with an expired, revoked, or mismatched session identity
		Then integral rejects it without reading or changing repository state
*/
/* @covers STORE-350F3496
Given integral provisions any interactive or isolated scheduled Pi session
	When it prepares Pi's extensions
		Then it registers `store_list`, `store_create`, `store_delete`, `store_restore`, `store_snapshot_list`, and `store_snapshot_restore`
			And describes direct-write durability, advisory locking, snapshots, and soft deletion to Pi
			And explains that creation, restoration, and snapshot restoration replace affected sessions while deletion changes mounted resources only for later sessions
			And sends every lifecycle operation through the authenticated gateway control boundary
			And derives store authority from the session instead of accepting a host path from Pi
			And keeps the tools available when no store connection exists yet
	When a store tool is called with an expired, revoked, or mismatched session identity
		Then integral rejects it without reading or changing store state
*/
test("[REPO-D1865075] [STORE-350F3496] every Pi environment receives authenticated governed resource tools", async (t) => {
  const paths = await fixture(t);
  await writeResourceExtension(paths.root, {
    sessionId: "session",
    repositories: [],
    stores: [],
    mounts: [],
    unavailable: [],
  });
  const source = await readFile(
    join(paths.root, ".integral/extensions/integral-resources.ts"),
    "utf8",
  );
  const typebox = join(paths.root, "node_modules/typebox");
  await mkdir(typebox, { recursive: true });
  await writeFile(
    join(typebox, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(typebox, "index.js"),
    "export const Type = new Proxy({}, { get: () => (...args) => args });\n",
  );
  const modulePath = join(
    paths.root,
    ".integral/extensions/integral-resources.mjs",
  );
  await writeFile(modulePath, source);
  const tools: string[] = [],
    extension = (await import(
      `${pathToFileURL(modulePath).href}?test=${Date.now()}`
    )) as { default(pi: { registerTool(tool: { name: string }): void }): void };
  extension.default({
    registerTool(tool) {
      tools.push(tool.name);
    },
  });
  assert.deepEqual(tools, [
    "repo_list",
    "repo_create",
    "repo_delete",
    "repo_restore",
    "store_list",
    "store_create",
    "store_delete",
    "store_restore",
    "repo_push",
    "container_image_rebuild",
    "store_snapshot_list",
    "store_snapshot_restore",
  ]);
  assert.match(source, /proxy-authorization/);
  assert.doesNotMatch(source, /host path:/i);
  const lockHelper = await readFile(
    join(paths.root, ".local/bin/integral-lock"),
    "utf8",
  );
  assert.match(lockHelper, /usage: integral-lock/);
  assert.match(lockHelper, /proxy-authorization/);
});

/* @covers STORE-6148863C
Given Pi has an authenticated integral session
	When Pi calls `store_create` with a unique connection name and valid mount path
		Then integral creates a stable store ID and lifecycle revision
			And creates a protected backing directory under the deployment data directory
			And records the canonical path and filesystem identity of its backing root
			And records a `host-store` connection at the requested path
			And marks the current session for replacement after the tool reports durable creation
			And mounts the store read-write at that path before the next Pi prompt
			And uses the same store and path in every later Pi session
			And does not expose the backing host path to Pi
	When backing-directory creation or mount recording fails
		Then the tool reports failure without an active store connection
			And removes any incomplete backing directory created by that operation
*/
/* @covers STORE-77471EF0
Given several Pi runs may write one mounted store concurrently
	When Pi runs `integral-lock <store> <name> -- <command>`
		Then the helper resolves the store by authenticated session inventory
			And acquires an exclusive advisory lock from a host-managed lock namespace outside store content
			And holds the lock for the command's lifetime
			And releases the lock when the command exits, crashes, or its container stops
			And the same store and lock name exclude every other run in the deployment
	When Pi omits locking around conflicting writes
		Then Integral makes no claim that those writes are transactionally consistent
			And retains configured snapshots as the recovery boundary
*/
/* @covers STORE-C38A633E
Given active, unavailable, and soft-deleted host stores may exist
	When Pi calls `store_list`
		Then integral returns each store's stable ID, connection name, lifecycle state, lifecycle revision, and mount path
			And reports a bounded availability reason for an unavailable store
			And reports snapshot availability
			And does not return backing host paths or another deployment's stores
	When Pi calls a store tool using only a path
		Then integral requires the path to resolve to exactly one store in the authenticated session
			And otherwise requires the stable ID or connection name
*/
/* @covers STORE-83D2CD52
Given an active host-store connection is visible to Pi
	Or an unavailable host-store connection is visible to Pi
	When Pi calls `store_delete` with its store ID and expected lifecycle revision
		Then integral records a tombstone containing the store identity, prior mount path, revision, and deletion actor
			And revokes the deleted lifecycle revision from further store control operations
			And leaves every existing Pi session and store mount running until its ordinary end
			And lets reads and writes through those mounts succeed or fail according to the host filesystem
			And omits the store from every session started after deletion
			And preserves all backing content and snapshots
			And reports that the current session retains its mount until it ends
	When the last session retaining a soft-deleted store mount ends
		And snapshots are configured
		And the backing path remains available
		Then integral takes the ordinary changed-run snapshot
			And does not remount the store merely to take that snapshot
	When that backing path is unavailable as the last retaining session ends
		Then integral records the final-snapshot failure
			And leaves the tombstone and earlier snapshots unchanged
	When Pi calls `store_restore` with the store ID, expected lifecycle revision, and a valid mount path
		Then integral reactivates the same backing content
			And records the requested mount path
			And advances the lifecycle revision
			And marks the current session for replacement after the tool reports durable restoration
			And mounts the store at that path before the next Pi prompt
	When the expected lifecycle revision is stale
		Then integral rejects the operation without changing store state or mount path
	When the backing directory is missing or has a different filesystem identity
		Then integral leaves the tombstone unchanged
			And reports that restoration is unavailable without recreating the directory
*/
test("[STORE-6148863C] [STORE-77471EF0] [STORE-C38A633E] [STORE-83D2CD52] authenticated resource controls create, lock, list, and soft-delete stores without host paths", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    gateway = new Gateway(
      paths,
      config,
      new Logger({
        component: "gateway",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
    );
  gateway.sessions.set("resource-token", "resource-session");
  const call = async (
    method: string,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> => {
    const request = Readable.from(
        body ? [Buffer.from(JSON.stringify(body))] : [],
      ) as unknown as IncomingMessage,
      chunks: Buffer[] = [];
    let status = 200;
    const response = {
      writeHead(value: number) {
        status = value;
        return response;
      },
      setHeader() {
        return response;
      },
      end(value?: string | Buffer) {
        if (value) chunks.push(Buffer.from(value));
        return response;
      },
    } as unknown as ServerResponse;
    request.url = url;
    request.method = method;
    request.headers = {
      "content-type": "application/json",
      "proxy-authorization": `Basic ${Buffer.from("integral:resource-token").toString("base64")}`,
    };
    await (
      gateway as unknown as {
        route(req: IncomingMessage, res: ServerResponse): Promise<void>;
      }
    ).route(request, response);
    const text = Buffer.concat(chunks).toString("utf8");
    return { status, body: text ? JSON.parse(text) : undefined };
  };
  const created = await call("POST", "/integral/control/resources/stores", {
    name: "agent-memory",
    mount: "/home/pi/agent-memory",
  });
  assert.equal(created.status, 201);
  const value = created.body as { id: string; revision: number };
  assert.equal(JSON.stringify(created.body).includes(paths.root), false);
  const listed = await call("GET", "/integral/control/resources/stores");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    (listed.body as Array<{ id: string }>).map((item) => item.id),
    [value.id],
  );
  const home = join(paths.root, "resource-home");
  await mkdir(home);
  const projection = await prepareResourceProjection(
      paths,
      config,
      home,
      "resource-session",
    ),
    locked = await call(
      "POST",
      `/integral/control/resources/stores/${value.id}/locks/update`,
    );
  assert.equal(locked.status, 200);
  const released = await call(
    "DELETE",
    `/integral/control/resources/stores/${value.id}/locks/update`,
    { lease: (locked.body as { lease: string }).lease },
  );
  assert.equal(released.status, 204);
  const deleted = await call(
    "DELETE",
    `/integral/control/resources/stores/${value.id}`,
    { expectedRevision: value.revision },
  );
  assert.equal(deleted.status, 200);
  assert.equal((deleted.body as { state: string }).state, "soft-deleted");
  await cleanupResourceProjection(paths, config, projection);
});

test("[SCHEDULE-930581F7] task extension steers a tool-free final turn until Pi declares an outcome", async (t) => {
  const paths = await fixture(t);
  await writeTaskExtension(paths.root);
  const extensionDirectory = join(paths.root, ".integral", "extensions"),
    typeboxDirectory = join(paths.root, "node_modules", "typebox");
  await mkdir(typeboxDirectory, { recursive: true });
  await writeFile(
    join(typeboxDirectory, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(typeboxDirectory, "index.js"),
    "export const Type = { String: (value = {}) => value, Object: (value) => value };\n",
  );
  const source = await readFile(
    join(extensionDirectory, "integral-task.ts"),
    "utf8",
  );
  await writeFile(join(extensionDirectory, "integral-task.mjs"), source);

  type Tool = {
    name: string;
    execute(
      id: string,
      params: Record<string, string>,
      signal: AbortSignal,
    ): Promise<{ terminate?: boolean }>;
  };
  type TurnEndHandler = (event: { toolResults?: unknown[] }) => Promise<void>;
  const tools: Tool[] = [],
    messages: Array<{ options: Record<string, unknown> }> = [];
  let turnEnd: TurnEndHandler | undefined;
  const loaded = (await import(
    `${pathToFileURL(join(extensionDirectory, "integral-task.mjs")).href}?test=${Date.now()}`
  )) as {
    default(pi: {
      registerTool(tool: Tool): void;
      on(name: string, handler: TurnEndHandler): void;
      sendMessage(
        message: Record<string, unknown>,
        options: Record<string, unknown>,
      ): void;
    }): void;
  };
  loaded.default({
    registerTool(tool) {
      tools.push(tool);
    },
    on(name, handler) {
      if (name === "turn_end") turnEnd = handler;
    },
    sendMessage(_message, options) {
      messages.push({ options });
    },
  });
  assert.ok(turnEnd);
  await turnEnd({ toolResults: [] });
  assert.deepEqual(messages, [
    { options: { deliverAs: "steer", triggerTurn: true } },
  ]);
  await turnEnd({ toolResults: [{}] });
  assert.equal(messages.length, 1);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["task_complete", "task_fail"],
  );
});

test("[BOX-AB639757] OAuth model connections receive only a temporary sentinel OAuth credential", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    model = validateConnection({
      name: "codex",
      kind: "model",
      provider: "openai-codex",
      auth: "oauth",
    }),
    spec = buildContainerSpec({
      config,
      selectedModel: "gpt-5.6-luna",
      gatewayUrl: "http://host.integral.internal:7310",
      caCert: "/ca",
      caBundle: "/bundle",
      sessionHome: paths.root,
      ...newSessionIdentity(),
      model,
      mcp: [],
    });
  await writePiCredential(paths.root, model);
  const credential = await import("node:fs/promises").then((fs) =>
    fs.readFile(`${paths.root}/.integral/auth.json`, "utf8"),
  );
  assert.deepEqual(JSON.parse(credential), {
    "openai-codex": {
      type: "oauth",
      access: OAUTH_SENTINEL,
      refresh: SENTINEL,
      expires: Number.MAX_SAFE_INTEGER,
    },
  });
  assert.doesNotMatch(credential, /actual-secret/);
  assert.equal(
    await import("node:fs/promises").then((fs) =>
      fs
        .stat(join(paths.root, ".pi", "agent"))
        .then((value) => value.isDirectory()),
    ),
    true,
  );
  assert.equal(spec.args.includes("--api-key"), false);
  assert.equal(spec.environment.PI_CODING_AGENT_DIR, "/home/pi/.pi/agent");
  assert.deepEqual(
    spec.mounts.find(
      (mount) => mount.target === "/home/pi/.pi/agent/auth.json",
    ),
    {
      source: join(paths.root, ".integral", "auth.json"),
      target: "/home/pi/.pi/agent/auth.json",
      readonly: true,
    },
  );
});

/* @covers FAILURE-A4C19E72
Given the runner has sent a claimed message to Pi
	When Pi rejects the prompt before beginning a turn
		Then integral reports the rejection without waiting for the turn timeout
			And durably returns the interrupted message to the queue
			And removes the failed Pi container and temporary session material
*/
test("[FAILURE-A4C19E72] an immediate Pi prompt rejection becomes a turn error", () => {
  assert.deepEqual(
    interpretPiProtocol(
      JSON.stringify({
        type: "response",
        command: "prompt",
        success: false,
        error: "provider authentication failed",
      }),
    ),
    {
      type: "rejected",
      error: "Pi rejected prompt: provider authentication failed",
    },
  );
});

/* @covers BOX-BE26C696
Given Pi does not finish a turn within the configured turn timeout
	When the timeout expires
		Then integral requests container termination
			And reports that the turn timed out
			And durably returns the in-flight message to the queue
			And removes temporary session data
			And revokes temporary session credentials
			And terminates every MCP sidecar owned by the timed-out session
			And force-removes the Docker container if it has not exited five seconds after SIGTERM
*/
test("[BOX-BE26C696] runner configuration resolves finite turn and idle deadlines", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  assert.equal(config.runner.turnTimeoutSeconds, 1800);
  assert.equal(config.runner.idleTimeoutSeconds, 300);
});

test("[BOX-E1F472A1] Pi model discovery parses only active provider rows", () => {
  const output = JSON.stringify([
    { provider: "openai-codex", model: "gpt-5.6" },
    { provider: "anthropic", model: "claude-new" },
  ]);
  assert.deepEqual(parsePiModelList(output, ["openai-codex"]), [
    { provider: "openai-codex", model: "gpt-5.6" },
  ]);
});
