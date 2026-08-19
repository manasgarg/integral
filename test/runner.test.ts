import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ContainerBackend,
  ContainerSpec,
  PiRuntime,
  TaskRuntime,
} from "../src/container.ts";
import { loadConfig } from "../src/config.ts";
import {
  listConnections,
  saveConnection,
  validateConnection,
} from "../src/connections.ts";
import { Logger } from "../src/logging.ts";
import { Runner, type RunnerClock } from "../src/runner.ts";
import type { ResourceProjection } from "../src/resources.ts";
import {
  deploymentId,
  readComponentState,
  writeComponentState,
} from "../src/state.ts";
import { fixture } from "./helpers.ts";

function emptyProjection(sessionId: string): ResourceProjection {
  return {
    sessionId,
    repositories: [],
    stores: [],
    mounts: [],
    unavailable: [],
  };
}

function profileProjection(sessionId: string): ResourceProjection {
  return {
    ...emptyProjection(sessionId),
    repositories: [
      {
        resource: {
          id: "profile-id",
          connection: "pi-profile",
          kind: "host-repo",
          path: "/host/profile.git",
          mount: "/home/pi/.pi",
          branch: "main",
          identity: { device: "1", inode: "2" },
          state: "active",
          revision: 1,
          writePolicy: "direct",
        },
        checkout: "/test/session/.pi",
        initialHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
  };
}

class ManualClock implements RunnerClock {
  readonly timers: {
    callback: () => void | Promise<void>;
    milliseconds: number;
  }[] = [];

  setTimeout(
    callback: () => void | Promise<void>,
    milliseconds: number,
  ): unknown {
    const timer = { callback, milliseconds };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    const index = this.timers.indexOf(
      handle as {
        callback: () => void | Promise<void>;
        milliseconds: number;
      },
    );
    if (index >= 0) this.timers.splice(index, 1);
  }

  async fire(milliseconds: number): Promise<void> {
    const index = this.timers.findIndex(
      (timer) => timer.milliseconds === milliseconds,
    );
    assert.notEqual(index, -1, `no timer scheduled for ${milliseconds}ms`);
    const [timer] = this.timers.splice(index, 1);
    await timer!.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/* @covers FAILURE-3780301D
Given the runner has not claimed its next message
	When gateway state is missing or not ready
		Then the runner marks itself degraded
			And does not claim new work
			And does not fall back to direct internet access
Given a chat turn is already in progress
	When the prompt fails with a gateway, container, timeout, or exit error
		Then the runner removes the failed Pi container
			And integral does not place a real credential in any replacement container
			And the coordinator durably returns the interrupted message to the queue
			And reports the turn error to attached terminals
*/
test("[FAILURE-3780301D] runner degrades without claiming work when gateway state is absent", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = {
      ...base,
      logging: { ...base.logging, level: "error" as const },
    },
    deployment = deploymentId(paths);
  for (const component of ["coordinator", "runner"] as const)
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: "http://127.0.0.1:1",
      pid: process.pid,
      status: "ready",
      fingerprint: config.fingerprint,
      connectionGeneration: 0,
      startedAt: "now",
    });
  let internalRequests = 0;
  const runner = new Runner(
    paths,
    config,
    new Logger({
      component: "runner",
      deploymentId: deployment,
      level: "error",
      format: "json",
      sink: () => undefined,
    }),
    {
      clock: new ManualClock(),
      async internalFetch() {
        internalRequests++;
        throw new Error("must not claim without the gateway");
      },
    },
  );
  await runner.runOnce();
  assert.equal(internalRequests, 0);
  const state = await readComponentState(paths, "runner");
  assert.equal(state?.status, "degraded");
  assert.match(state?.error ?? "", /configuration or connection generations/);
});

test("[MCP-5751370A] [MCP-6F5CFA0E] runner detects validated catalog changes between turns and retains the active catalog on refresh failure", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  await saveConnection(
    paths,
    validateConnection({
      name: "dynamic",
      kind: "mcp",
      url: "https://dynamic.example.test/mcp",
      auth: "none",
    }),
  );
  let tool = "old",
    fail = false;
  const runner = new Runner(
      paths,
      config,
      new Logger({
        component: "runner",
        deploymentId: deploymentId(paths),
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        async discoverRemoteMcp(connection) {
          if (fail) throw new Error("catalog refresh failed");
          return {
            connection,
            protocolVersion: "2025-11-25",
            tools: [{ name: tool, inputSchema: { type: "object" } }],
          };
        },
      },
    ),
    internals = runner as unknown as {
      piMcpCatalogs: Map<string, string>;
      mcpCatalogChanged(): Promise<boolean>;
    };
  internals.piMcpCatalogs = new Map([
    [
      "dynamic",
      JSON.stringify([{ name: "old", inputSchema: { type: "object" } }]),
    ],
  ]);
  assert.equal(await internals.mcpCatalogChanged(), false);
  tool = "new";
  assert.equal(await internals.mcpCatalogChanged(), true);
  internals.piMcpCatalogs = new Map([
    [
      "dynamic",
      JSON.stringify([{ name: "new", inputSchema: { type: "object" } }]),
    ],
  ]);
  fail = true;
  assert.equal(await internals.mcpCatalogChanged(), false);
  assert.deepEqual(
    (await listConnections(paths)).map((connection) => [
      connection.name,
      connection.state,
      connection.availabilityReason,
    ]),
    [["dynamic", "degraded", "discovery"]],
  );
});

/* @covers BOX-7D3A19E4
Given the durable queue is empty
	And the Pi session has no turn in flight
	When the Pi idle timeout expires
		Then integral terminates the Pi container
			And terminates every MCP sidecar owned by that Pi session
			And revokes its temporary session token
			And preserves the durable conversation record and queue
			And keeps attached terminals connected
			And starts a replacement session when another message is queued
*/
test("[BOX-B45DEA9B] [BOX-7D3A19E4] [RUN-B1D837E0] [RUN-01CA16F2] [RUN-88706C0D] runner reuses one recorded Pi runtime and destroys it after the configured idle deadline", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = {
      ...base,
      server: { ...base.server, runnerPort: 0 },
      logging: { ...base.logging, level: "error" as const },
    },
    clock = new ManualClock(),
    calls: string[] = [];
  await saveConnection(
    paths,
    validateConnection({
      name: "model",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "secret",
  );
  await saveConnection(
    paths,
    validateConnection({
      name: "mail",
      kind: "email",
      provider: "mailgun",
      auth: "key",
      capabilities: ["send"],
      domain: "mg.example.com",
      from_address: "robot@mg.example.com",
      allowed_recipients: ["person@example.com"],
    }),
    "mail-secret",
  );
  const deployment = deploymentId(paths);
  for (const component of ["coordinator", "gateway", "runner"] as const)
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: `http://127.0.0.1:${component === "gateway" ? 7310 : component === "coordinator" ? 7311 : 7312}`,
      pid: process.pid,
      status: "ready",
      fingerprint: config.fingerprint,
      connectionGeneration: 2,
      startedAt: "now",
    });

  let spec: ContainerSpec | undefined,
    observe: ((event: Record<string, unknown>) => void) | undefined;
  const pi: PiRuntime = {
      get spec() {
        assert.ok(spec);
        return spec;
      },
      async start() {
        calls.push("pi:start");
      },
      async prompt(text) {
        calls.push(`pi:prompt:${text}`);
        observe?.({
          type: "message_end",
          message: {
            usage: {
              input: 12,
              output: 4,
              cacheRead: 8,
              cacheWrite: 2,
            },
          },
        });
        return "answer";
      },
      async stop() {
        calls.push("pi:stop");
      },
    },
    containers: ContainerBackend = {
      ensureImage() {
        calls.push("image");
        return "sha256:test-pi";
      },
      async ensureNetwork() {
        calls.push("network");
      },
      networkGateway() {
        return "127.0.0.1";
      },
      createPi(value, _config, _network, _stderr, onEvent) {
        calls.push("pi:create");
        spec = value;
        observe = onEvent;
        return pi;
      },
      createTaskPi() {
        throw new Error("unexpected task runtime");
      },
    };
  let claims = 0;
  const runner = new Runner(
    paths,
    config,
    new Logger({
      component: "runner",
      deploymentId: deployment,
      level: "error",
      format: "json",
      sink: () => undefined,
    }),
    {
      containers,
      clock,
      fetch: async () => new Response("ok"),
      async internalFetch(_paths, _caller, _target, path, init) {
        calls.push(`${init?.method ?? "GET"}:${path}`);
        if (path === "/integral/internal/claim") {
          claims++;
          return Response.json({
            message:
              claims === 1
                ? {
                    id: "message-1",
                    text: "hello",
                    order: 1,
                    status: "in-flight",
                    attempts: 1,
                    createdAt: "now",
                  }
                : undefined,
            selection: {
              connection: "model",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              piVersion: "1.2.3",
              piImage: "sha256:test-pi",
            },
            context: [],
          });
        }
        return new Response(null, { status: 204 });
      },
      ensureCa: async () => ({
        key: "/test/ca.key",
        cert: "/test/ca.pem",
        bundle: "/test/bundle.pem",
      }),
      freshSessionHome: async () => "/test/session",
      ensurePiProfileRepository: async () => {
        calls.push("profile:ensure");
        return {} as never;
      },
      prepareResourceProjection: async () => profileProjection("session-1"),
      cleanupResourceProjection: async () => undefined,
      newSessionIdentity: () => ({
        sessionId: "session-1",
        sessionToken: "token-1",
      }),
      writeMcpExtension: async () => undefined,
      writeResourceExtension: async () => undefined,
      async writeEmailExtension(home, connections) {
        assert.equal(home, "/test/session");
        assert.deepEqual(
          connections.map((connection) => connection.name),
          ["mail"],
        );
        calls.push("talk:email-tools");
      },
      writePiCredential: async () => undefined,
      listen: async () => undefined,
      close: async () => undefined,
    },
  );
  await runner.start();
  await runner.runOnce();
  await runner.runOnce();

  assert.equal(calls.filter((call) => call === "profile:ensure").length, 1);
  assert.equal(calls.filter((call) => call === "pi:create").length, 1);
  assert.equal(calls.filter((call) => call === "talk:email-tools").length, 1);
  assert.ok(calls.includes("pi:prompt:hello"));
  assert.equal(spec?.image, "sha256:test-pi");
  assert.ok(spec?.args.includes("claude-sonnet-4-6"));
  for (const extension of [
    "integral-mcp.ts",
    "integral-resources.ts",
    "integral-email.ts",
  ])
    assert.ok(
      spec?.args.includes(`/home/pi/.integral/extensions/${extension}`),
    );
  assert.match(spec?.args.at(-1) ?? "", /ephemeral Integral-managed container/);
  const historyMount = spec?.mounts.find(
    (mount) => mount.target === "/home/pi/history",
  );
  assert.equal(historyMount?.readonly, true);
  assert.ok(historyMount);
  assert.ok(historyMount.source.startsWith(`${paths.runViews}/`));
  assert.equal(historyMount.source.startsWith(`${paths.runs}/`), false);
  assert.deepEqual(
    JSON.parse(await readFile(join(historyMount.source, "index.json"), "utf8")),
    { schemaVersion: 1, runs: [] },
  );
  assert.deepEqual(await readdir(join(historyMount.source, "runs")), []);
  const currentMetadata = JSON.parse(
      await readFile(join(historyMount.source, "current", "run.json"), "utf8"),
    ) as { status: string },
    currentActivity = await readFile(
      join(historyMount.source, "current", "activity.jsonl"),
      "utf8",
    ),
    currentSignals = JSON.parse(
      await readFile(
        join(historyMount.source, "current", "signals.json"),
        "utf8",
      ),
    ) as { usage: { inputTokens: number; cacheReadTokens: number } };
  assert.equal(currentMetadata.status, "running");
  assert.match(currentActivity, /hello/);
  assert.match(currentActivity, /answer/);
  assert.match(
    currentActivity,
    /pi-profile.*aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
  );
  assert.equal(currentSignals.usage.inputTokens, 12);
  assert.equal(currentSignals.usage.cacheReadTokens, 8);
  await clock.fire(config.runner.idleTimeoutSeconds * 1000);
  assert.ok(calls.includes("pi:stop"));
  assert.ok(calls.includes("DELETE:/integral/internal/session"));
  const runDirectories = await readdir(paths.runs);
  assert.equal(runDirectories.length, 1);
  const runDirectory = join(paths.runs, runDirectories[0]!);
  const metadata = JSON.parse(
      await readFile(join(runDirectory, "run.json"), "utf8"),
    ) as { status: string; termination: string },
    signals = JSON.parse(
      await readFile(join(runDirectory, "signals.json"), "utf8"),
    ) as {
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        unavailable: string[];
      };
    };
  assert.equal(metadata.status, "finalized");
  assert.equal(metadata.termination, "idle");
  assert.equal(signals.usage.inputTokens, 12);
  assert.equal(signals.usage.outputTokens, 4);
  assert.equal(signals.usage.cacheReadTokens, 8);
  assert.equal(signals.usage.cacheWriteTokens, 2);
  assert.deepEqual(signals.usage.unavailable.sort(), [
    "cost",
    "reasoningTokens",
    "totalTokens",
  ]);
  await runner.stop();
});

/* @covers BOX-C28F4A61
Given the runner has claimed a queued message
	When it cannot provision or start the Pi container
		Then integral durably returns the message to its prior queue position
			And terminates every partially started MCP sidecar
			And records the provisioning failure
			And reports the failure to every attached terminal
*/
/* @covers FAILURE-071CB99A
Given a chat turn is in progress
	When the Pi process or container exits unexpectedly
		Then integral records that the response did not complete
			And reports the interruption to every attached terminal
			And does not present partial protocol output as a complete answer
			And durably returns the interrupted message to the queue
			And removes the container and temporary session material
*/
test("[BOX-BE26C696] [BOX-C28F4A61] [FAILURE-071CB99A] [FAILURE-3780301D] [FAILURE-A4C19E72] runner releases claimed work and destroys a failed Pi runtime", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = {
      ...base,
      logging: { ...base.logging, level: "error" as const },
    },
    calls: string[] = [],
    spec = {
      image: "test",
      args: [],
      environment: {},
      mounts: [],
      sessionId: "session-2",
      sessionToken: "token-2",
      home: "/test/session",
      gatewayAddress: "127.0.0.1",
    } satisfies ContainerSpec,
    pi: PiRuntime = {
      spec,
      async start() {},
      async prompt() {
        throw new Error("Pi rejected prompt: gateway authentication failed");
      },
      async stop() {
        calls.push("pi:stop");
      },
    };
  await saveConnection(
    paths,
    validateConnection({
      name: "model",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "secret",
  );
  const deployment = deploymentId(paths);
  for (const component of ["coordinator", "gateway", "runner"] as const)
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: "http://127.0.0.1:1",
      pid: process.pid,
      status: "ready",
      fingerprint: config.fingerprint,
      connectionGeneration: 1,
      startedAt: "now",
    });
  const runner = new Runner(
    paths,
    config,
    new Logger({
      component: "runner",
      deploymentId: deployment,
      level: "error",
      format: "json",
      sink: () => undefined,
    }),
    {
      containers: {
        ensureImage() {
          return "sha256:test-pi";
        },
        async ensureNetwork() {},
        networkGateway: () => "127.0.0.1",
        createPi: () => pi,
        createTaskPi() {
          throw new Error("unexpected task runtime");
        },
      },
      clock: new ManualClock(),
      fetch: async () => new Response("ok"),
      async internalFetch(_paths, _caller, _target, path) {
        calls.push(path);
        if (path === "/integral/internal/claim")
          return Response.json({
            message: {
              id: "message-2",
              text: "fail",
              order: 1,
              status: "in-flight",
              attempts: 1,
              createdAt: "now",
            },
            selection: {
              connection: "model",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              piVersion: "1.2.3",
              piImage: "sha256:test-pi",
            },
            context: [],
          });
        return new Response(null, { status: 204 });
      },
      ensureCa: async () => ({ key: "key", cert: "cert", bundle: "bundle" }),
      freshSessionHome: async () => "/test/session",
      prepareResourceProjection: async () => emptyProjection("session-2"),
      newSessionIdentity: () => ({
        sessionId: "session-2",
        sessionToken: "token-2",
      }),
      writeMcpExtension: async () => undefined,
      writeResourceExtension: async () => undefined,
      writePiCredential: async () => undefined,
      listen: async () => undefined,
      close: async () => undefined,
    },
  );

  await runner.runOnce();

  assert.ok(calls.includes("/integral/internal/work/message-2/release"));
  assert.ok(calls.includes("pi:stop"));
  assert.ok(calls.includes("/integral/internal/session"));
});

test("[CHAT-C53A90D2] runner recycles an idle Pi container after the conversation selection changes", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = {
      ...base,
      logging: { ...base.logging, level: "error" as const },
    },
    deployment = deploymentId(paths),
    calls: string[] = [],
    pi: PiRuntime = {
      spec: {
        image: "test",
        args: [],
        environment: {},
        mounts: [],
        sessionId: "old-session",
        sessionToken: "old-token",
        home: "/test/session",
        gatewayAddress: "127.0.0.1",
      },
      async start() {},
      async prompt() {
        return "unused";
      },
      async stop() {
        calls.push("pi:stop");
      },
    };
  for (const component of ["coordinator", "gateway", "runner"] as const)
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: "http://127.0.0.1:1",
      pid: process.pid,
      status: "ready",
      fingerprint: config.fingerprint,
      connectionGeneration: 0,
      startedAt: "now",
    });
  const runner = new Runner(
    paths,
    config,
    new Logger({
      component: "runner",
      deploymentId: deployment,
      level: "error",
      format: "json",
      sink: () => undefined,
    }),
    {
      clock: new ManualClock(),
      fetch: async () => new Response("ok"),
      async internalFetch(_paths, _caller, _target, path, init) {
        calls.push(`${init?.method ?? "GET"}:${path}`);
        if (path === "/integral/internal/claim")
          return Response.json({
            message: null,
            selection: {
              connection: "work",
              provider: "openai-codex",
              model: "gpt-5.5",
              piVersion: "1.2.4",
              piImage: "sha256:new-pi",
            },
            context: [],
          });
        return new Response(null, { status: 204 });
      },
    },
  );
  (runner as any).pi = pi;
  (runner as any).piSelection = {
    connection: "personal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    piVersion: "1.2.3",
    piImage: "sha256:old-pi",
  };

  await runner.runOnce();

  assert.ok(calls.includes("pi:stop"));
  assert.ok(calls.includes("DELETE:/integral/internal/session"));
  assert.equal((runner as any).pi, undefined);
});

test("an approval continuation starts a replacement Pi session with parent lineage", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = {
      ...base,
      logging: { ...base.logging, level: "error" as const },
    },
    deployment = deploymentId(paths),
    calls: string[] = [];
  await saveConnection(
    paths,
    validateConnection({
      name: "model",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "secret",
  );
  for (const component of ["coordinator", "gateway", "runner"] as const)
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: "http://127.0.0.1:1",
      pid: process.pid,
      status: "ready",
      fingerprint: config.fingerprint,
      connectionGeneration: 1,
      startedAt: "now",
    });
  const old: PiRuntime = {
      spec: {
        image: "sha256:test-pi",
        args: [],
        environment: {},
        mounts: [],
        sessionId: "session-ended",
        sessionToken: "old-token",
        home: "/test/old",
        gatewayAddress: "127.0.0.1",
      },
      async start() {},
      async prompt() {
        return "unused";
      },
      async stop() {
        calls.push("old:stop");
      },
    },
    selection = {
      connection: "model",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      piVersion: "1.2.3",
      piImage: "sha256:test-pi",
    },
    runner = new Runner(
      paths,
      config,
      new Logger({
        component: "runner",
        deploymentId: deployment,
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        containers: {
          ensureImage: () => "sha256:test-pi",
          async ensureNetwork() {},
          networkGateway: () => "127.0.0.1",
          createPi(spec) {
            return {
              spec,
              async start() {
                calls.push("replacement:start");
              },
              async prompt(text) {
                calls.push(`replacement:prompt:${text}`);
                return "approval acknowledged";
              },
              async stop() {},
            };
          },
          createTaskPi() {
            throw new Error("unexpected task runtime");
          },
        },
        clock: new ManualClock(),
        fetch: async () => new Response("ok"),
        async internalFetch(_paths, _caller, target, path, init) {
          if (path === "/integral/internal/claim")
            return Response.json({
              message: {
                id: "approval-message",
                text: "Approval approval-1 resolved as succeeded.",
                order: 1,
                status: "in-flight",
                attempts: 1,
                createdAt: "now",
                approvalContinuation: {
                  approvalId: "approval-1",
                  originSessionId: "session-ended",
                  originRunId: "run-ended",
                  outcome: "succeeded",
                  summary: "install Debian packages: jq",
                },
              },
              selection,
              context: [],
            });
          if (
            target === "coordinator" &&
            path === "/integral/internal/session" &&
            init?.method === "POST" &&
            typeof init.body === "string"
          )
            calls.push(`session:${init.body}`);
          return new Response(null, { status: 204 });
        },
        ensureCa: async () => ({ key: "key", cert: "cert", bundle: "bundle" }),
        freshSessionHome: async () => "/test/replacement",
        newSessionIdentity: () => ({
          sessionId: "session-replacement",
          sessionToken: "replacement-token",
        }),
        writeMcpExtension: async () => undefined,
        writeResourceExtension: async () => undefined,
        writeEmailExtension: async () => undefined,
        writePiCredential: async () => undefined,
        prepareResourceProjection: async () => ({
          sessionId: "session-replacement",
          repositories: [],
          stores: [],
          mounts: [],
          unavailable: [],
        }),
        cleanupResourceProjection: async () => undefined,
        listen: async () => undefined,
        close: async () => undefined,
      },
    );
  (runner as any).pi = old;
  (runner as any).piSelection = selection;
  (runner as any).piSessionGeneration = 1;

  await runner.runOnce();

  assert.ok(calls.includes("old:stop"), JSON.stringify(calls));
  assert.ok(calls.includes("replacement:start"));
  assert.ok(
    calls.includes(
      "replacement:prompt:Approval approval-1 resolved as succeeded.",
    ),
  );
  const metadataFiles = await readdir(paths.runs),
    metadata = JSON.parse(
      await readFile(join(paths.runs, metadataFiles[0]!, "run.json"), "utf8"),
    ) as {
      parentRunId?: string;
      parentSessionId?: string;
      approvalId?: string;
    };
  assert.equal(metadata.parentRunId, "run-ended");
  assert.equal(metadata.parentSessionId, "session-ended");
  assert.equal(metadata.approvalId, "approval-1");
  assert.ok(
    calls.some(
      (call) =>
        call.startsWith("session:") &&
        call.includes('"parentSessionId":"session-ended"') &&
        call.includes('"approvalId":"approval-1"'),
    ),
  );
  await runner.stop();
});

test("[CONNECTION-12C87631] runner recycles a Pi session after GitHub is connected", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = {
      ...base,
      logging: { ...base.logging, level: "error" as const },
    },
    deployment = deploymentId(paths),
    calls: string[] = [];
  await saveConnection(
    paths,
    validateConnection({
      name: "model",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "model-secret",
  );
  await saveConnection(
    paths,
    validateConnection({
      name: "github",
      kind: "http",
      provider: "github",
      auth: "key",
      hosts: ["api.github.com", "github.com"],
    }),
    "github-secret",
  );
  for (const component of ["coordinator", "gateway"] as const)
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: "http://127.0.0.1:1",
      pid: process.pid,
      status: "ready",
      fingerprint: config.fingerprint,
      connectionGeneration: 2,
      startedAt: "now",
    });
  const stale: PiRuntime = {
      spec: {
        image: "sha256:test-pi",
        args: [],
        environment: {},
        mounts: [],
        sessionId: "stale-session",
        sessionToken: "stale-token",
        home: "/test/stale-session",
        gatewayAddress: "127.0.0.1",
      },
      async start() {},
      async prompt() {
        return "unused";
      },
      async stop() {
        calls.push("stale:stop");
      },
    },
    runner = new Runner(
      paths,
      config,
      new Logger({
        component: "runner",
        deploymentId: deployment,
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      {
        containers: {
          ensureImage: () => "sha256:test-pi",
          async ensureNetwork() {},
          networkGateway: () => "127.0.0.1",
          createPi(spec) {
            assert.equal(
              spec.environment.GH_TOKEN,
              "integral-managed-credential",
            );
            return {
              spec,
              async start() {
                calls.push("replacement:start");
              },
              async prompt() {
                calls.push("replacement:prompt");
                return "GitHub is available";
              },
              async stop() {},
            };
          },
          createTaskPi() {
            throw new Error("unexpected task runtime");
          },
        },
        clock: new ManualClock(),
        fetch: async () => new Response("ok"),
        async internalFetch(_paths, _caller, _target, path) {
          if (path === "/integral/internal/claim")
            return Response.json({
              message: {
                id: "message-github",
                text: "check again",
                order: 1,
                status: "in-flight",
                attempts: 1,
                createdAt: "now",
              },
              selection: {
                connection: "model",
                provider: "anthropic",
                model: "claude-sonnet-4-6",
                piVersion: "1.2.3",
                piImage: "sha256:test-pi",
              },
              context: [],
            });
          return new Response(null, { status: 204 });
        },
        ensureCa: async () => ({ key: "key", cert: "cert", bundle: "bundle" }),
        freshSessionHome: async () => "/test/replacement-session",
        prepareResourceProjection: async () =>
          emptyProjection("replacement-session"),
        newSessionIdentity: () => ({
          sessionId: "replacement-session",
          sessionToken: "replacement-token",
        }),
        writeMcpExtension: async () => undefined,
        writeResourceExtension: async () => undefined,
        writeEmailExtension: async () => undefined,
        writePiCredential: async () => undefined,
        listen: async () => undefined,
        close: async () => undefined,
      },
    );
  (runner as any).pi = stale;
  (runner as any).piSelection = {
    connection: "model",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    piVersion: "1.2.3",
    piImage: "sha256:test-pi",
  };
  (runner as any).piSessionGeneration = 1;

  await runner.runOnce();

  assert.deepEqual(calls, [
    "stale:stop",
    "replacement:start",
    "replacement:prompt",
  ]);
  await runner.stop();
});

/* @covers SCHEDULE-033C050E
Given the coordinator task queue contains an occurrence ready to run
	And an interactive Pi container may already be active
	When the task executor claims the occurrence
		Then it never sends the task to the interactive container
			And creates a fresh temporary home, gateway session identity, and Pi container for the attempt
			And does not restore the interactive conversation transcript into the task
			And supplies only the self-contained task prompt and trusted schedule, execution, and attempt metadata
			And provisions governed connection capabilities through the same environment preparation path used by interactive talk
			And permits the interactive container to remain separate from the task container
*/
/* @covers SCHEDULE-81B854FB
Given Pi is running an isolated task attempt
	When integral supplies its trusted task context
		Then the context includes the stable schedule ID, execution ID, scheduled instant, and attempt number
			And retries of a one-time task retain the execution ID while changing the attempt identity
			And Pi can use the execution ID as an idempotency key for external operations
			And integral does not claim that coordinator idempotency prevents repeated external effects after an ambiguous failure
*/
test("[SCHEDULE-033C050E] [SCHEDULE-930581F7] [SCHEDULE-81B854FB] [RUN-B1D837E0] [RUN-88706C0D] task execution uses a fresh recorded one-shot runtime and completes only after exit zero", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = {
      ...base,
      logging: { ...base.logging, level: "error" as const },
    },
    deployment = deploymentId(paths),
    calls: string[] = [];
  let taskRegistration: Record<string, unknown> | undefined;
  await saveConnection(
    paths,
    validateConnection({
      name: "model",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "secret",
  );
  await saveConnection(
    paths,
    validateConnection({
      name: "mail",
      kind: "email",
      provider: "mailgun",
      auth: "key",
      capabilities: ["send"],
      domain: "mg.example.com",
      from_address: "robot@mg.example.com",
      allowed_recipients: ["person@example.com"],
    }),
    "mail-secret",
  );
  for (const component of ["coordinator", "gateway"] as const)
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: "http://127.0.0.1:1",
      pid: process.pid,
      status: "ready",
      fingerprint: config.fingerprint,
      connectionGeneration: 2,
      startedAt: "now",
    });
  const spec: ContainerSpec = {
      image: "sha256:test-pi",
      args: [],
      environment: {},
      mounts: [],
      sessionId: "task-session",
      sessionToken: "task-token",
      home: "/test/task-home",
      gatewayAddress: "127.0.0.1",
    },
    taskRuntime: TaskRuntime = {
      spec,
      async start() {
        calls.push("task:start");
      },
      async prompt(text) {
        calls.push(`task:prompt:${text}`);
        return "task result";
      },
      async finish() {
        calls.push("task:exit:0");
        return 0;
      },
      async stop() {
        calls.push("task:cleanup");
      },
    },
    task = {
      id: "execution-1",
      executionId: "execution-1",
      scheduleId: "schedule-1",
      scheduleRevision: 1,
      triggerType: "once" as const,
      scheduledFor: "2026-08-02T12:00:00.000Z",
      prompt: "perform scheduled work",
      profile: {
        connection: "model",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        piVersion: "1.2.3",
        piImage: "sha256:test-pi",
      },
      state: "claimed" as const,
      claimId: "claim-1",
      attempts: [],
      createdAt: "now",
    };
  const runner = new Runner(
    paths,
    config,
    new Logger({
      component: "runner",
      deploymentId: deployment,
      level: "error",
      format: "json",
      sink: () => undefined,
    }),
    {
      containers: {
        ensureImage: () => "sha256:test-pi",
        async ensureNetwork() {},
        networkGateway: () => "127.0.0.1",
        createPi() {
          throw new Error("task must not use the talk runtime factory");
        },
        createTaskPi(value) {
          calls.push("task:create");
          assert.match(value.args.at(-1)!, /Schedule ID: schedule-1/);
          assert.match(value.args.at(-1)!, /Execution ID: execution-1/);
          assert.match(value.args.at(-1)!, /Attempt: 1/);
          assert.match(
            value.args.at(-1)!,
            /Scheduled time: 2026-08-02T12:00:00.000Z/,
          );
          assert.match(value.args.at(-1)!, /task_complete or task_fail/);
          return taskRuntime;
        },
      },
      clock: new ManualClock(),
      fetch: async () => new Response("ok"),
      async internalFetch(_paths, _caller, target, path, init) {
        calls.push(`${init?.method ?? "GET"}:${target}:${path}`);
        if (
          target === "gateway" &&
          path === "/integral/internal/session" &&
          typeof init?.body === "string" &&
          init.body.includes("executionId")
        )
          taskRegistration = JSON.parse(init.body) as Record<string, unknown>;
        if (path === "/integral/internal/tasks/claim")
          return Response.json({ task });
        if (path.endsWith("/start"))
          return Response.json({
            ...task,
            state: "running",
            claimId: undefined,
            attempts: [{ attemptId: "attempt-1", number: 1, startedAt: "now" }],
          });
        if (path.endsWith("/complete")) return Response.json({ ok: true });
        return new Response(null, { status: 204 });
      },
      ensureCa: async () => ({ key: "key", cert: "cert", bundle: "bundle" }),
      freshSessionHome: async () => "/test/task-home",
      prepareResourceProjection: async () => emptyProjection("task-session"),
      newSessionIdentity: () => ({
        sessionId: "task-session",
        sessionToken: "task-token",
      }),
      writeMcpExtension: async () => undefined,
      writeResourceExtension: async () => undefined,
      async writeEmailExtension(home, connections) {
        assert.equal(home, "/test/task-home");
        assert.deepEqual(
          connections.map((connection) => connection.name),
          ["mail"],
        );
        calls.push("task:email-tools");
      },
      async writeTaskExtension(home) {
        assert.equal(home, "/test/task-home");
        calls.push("task:outcome-tools");
      },
      writePiCredential: async () => undefined,
      listen: async () => undefined,
      close: async () => undefined,
    },
  );
  (runner as any).dockerGateway = "127.0.0.1";

  await runner.runTaskOnce();

  assert.deepEqual(
    calls.filter((call) => call.startsWith("task:")),
    [
      "task:email-tools",
      "task:outcome-tools",
      "task:create",
      "task:start",
      "task:prompt:perform scheduled work",
      "task:exit:0",
      "task:cleanup",
    ],
  );
  const finalizeIndex = calls.findIndex((call) => call.endsWith("/finalize"));
  assert.ok(finalizeIndex > calls.indexOf("task:exit:0"));
  assert.equal(
    calls.filter((call) => call === "POST:gateway:/integral/internal/session")
      .length,
    2,
  );
  assert.deepEqual(taskRegistration, {
    token: "task-token",
    sessionId: "task-session",
    executionId: "execution-1",
    attemptId: "attempt-1",
  });
  assert.ok(calls.includes("DELETE:gateway:/integral/internal/session"));
  const runIds = await readdir(paths.runs);
  assert.equal(runIds.length, 1);
  const runDirectory = join(paths.runs, runIds[0]!),
    runMetadata = JSON.parse(
      await readFile(join(runDirectory, "run.json"), "utf8"),
    ) as {
      kind: string;
      status: string;
      termination: string;
      scheduleId: string;
      executionId: string;
      attemptId: string;
      attemptNumber: number;
      retryNumber: number;
    },
    activity = await readFile(join(runDirectory, "activity.jsonl"), "utf8");
  assert.deepEqual(
    {
      kind: runMetadata.kind,
      status: runMetadata.status,
      termination: runMetadata.termination,
      scheduleId: runMetadata.scheduleId,
      executionId: runMetadata.executionId,
      attemptId: runMetadata.attemptId,
      attemptNumber: runMetadata.attemptNumber,
      retryNumber: runMetadata.retryNumber,
    },
    {
      kind: "scheduled",
      status: "finalized",
      termination: "completed",
      scheduleId: "schedule-1",
      executionId: "execution-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      retryNumber: 0,
    },
  );
  assert.match(activity, /perform scheduled work/);
  assert.match(activity, /task result/);
});
