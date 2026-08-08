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

test("[BOX-40521095] authenticated package controls attach the Pi actor and cross only the internal coordinator boundary", async (t) => {
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
      actor: "pi:session-42",
    },
  });
});

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

test("[CONNECTION-4B8D73F1] [SCHEDULE-55BD779F] [BOX-40521095] temporary Pi extensions expose remote MCP and authenticated control tools", async (t) => {
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
    join(paths.root, ".pi/agent/extensions/integral-resources.ts"),
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
    ".pi/agent/extensions/integral-resources.mjs",
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
  const extensionDirectory = join(paths.root, ".pi", "agent", "extensions"),
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
