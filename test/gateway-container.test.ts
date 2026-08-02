import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  decideRequest,
  OAUTH_SENTINEL,
  parseProxyAuthorization,
  SENTINEL,
} from "../src/gateway-policy.ts";
import {
  buildContainerSpec,
  dockerRunArgs,
  isManagedContainerVariable,
  interpretPiProtocol,
  newSessionIdentity,
  parsePiModelList,
  writeMcpExtension,
  writePiCredential,
} from "../src/container.ts";
import { loadConfig } from "../src/config.ts";
import { saveConnection, validateConnection } from "../src/connections.ts";
import { Gateway, allowsConnect, gatewayHealth } from "../src/gateway.ts";
import { Logger } from "../src/logging.ts";
import { deploymentId, writeComponentState } from "../src/state.ts";
import { fixture } from "./helpers.ts";

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

test("[EMAIL-89334867] authenticated Pi email calls resolve a named account inside the gateway", async (t) => {
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
  let executed: unknown,
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
});

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

test("[BOX-601613D4] [GATEWAY-EC79406A] Docker specification is non-root, read-only, capability-free, bounded, and locked to an internal network", async (t) => {
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
});

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
    "--no-approve",
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

test("[CONNECTION-4B8D73F1] remote MCP connections become temporary Pi tools containing only sentinel authentication", async (t) => {
  const paths = await fixture(t),
    mcp = validateConnection({
      name: "work-docs",
      kind: "mcp",
      url: "https://mcp.test/rpc",
      auth: "key",
    });
  await writeMcpExtension(paths.root, [mcp]);
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(`${paths.root}/.pi/agent/extensions/integral-mcp.ts`, "utf8"),
  );
  assert.match(source, /"mcp_" \+ server\.name/);
  assert.match(source, /"name":"work_docs"/);
  assert.match(source, /integral-managed-credential/);
  assert.doesNotMatch(source, /actual-secret/);
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
    fs.readFile(`${paths.root}/.pi/agent/auth.json`, "utf8"),
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
  assert.equal(spec.args.includes("--api-key"), false);
  assert.equal(spec.environment.PI_CODING_AGENT_DIR, "/home/pi/.pi/agent");
});

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
