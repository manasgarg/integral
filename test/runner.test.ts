import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContainerBackend,
  ContainerSpec,
  PiRuntime,
  TaskRuntime,
} from "../src/container.ts";
import { loadConfig } from "../src/config.ts";
import { saveConnection, validateConnection } from "../src/connections.ts";
import { Logger } from "../src/logging.ts";
import { Runner, type RunnerClock } from "../src/runner.ts";
import { deploymentId, writeComponentState } from "../src/state.ts";
import { fixture } from "./helpers.ts";

class ManualClock implements RunnerClock {
  readonly timers: { callback: () => void; milliseconds: number }[] = [];

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const timer = { callback, milliseconds };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    const index = this.timers.indexOf(
      handle as { callback: () => void; milliseconds: number },
    );
    if (index >= 0) this.timers.splice(index, 1);
  }

  async fire(milliseconds: number): Promise<void> {
    const index = this.timers.findIndex(
      (timer) => timer.milliseconds === milliseconds,
    );
    assert.notEqual(index, -1, `no timer scheduled for ${milliseconds}ms`);
    const [timer] = this.timers.splice(index, 1);
    timer!.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("[BOX-B45DEA9B] [BOX-7D3A19E4] runner reuses one Pi runtime and destroys it after the configured idle deadline", async (t) => {
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
  const deployment = deploymentId(paths);
  for (const component of ["coordinator", "gateway", "runner"] as const)
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: `http://127.0.0.1:${component === "gateway" ? 7310 : component === "coordinator" ? 7311 : 7312}`,
      pid: process.pid,
      status: "ready",
      fingerprint: config.fingerprint,
      connectionGeneration: 1,
      startedAt: "now",
    });

  let spec: ContainerSpec | undefined;
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
      createPi(value) {
        calls.push("pi:create");
        spec = value;
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
      newSessionIdentity: () => ({
        sessionId: "session-1",
        sessionToken: "token-1",
      }),
      writeMcpExtension: async () => undefined,
      writePiCredential: async () => undefined,
      listen: async () => undefined,
      close: async () => undefined,
    },
  );
  await runner.start();
  await runner.runOnce();
  await runner.runOnce();

  assert.equal(calls.filter((call) => call === "pi:create").length, 1);
  assert.ok(calls.includes("pi:prompt:hello"));
  assert.equal(spec?.image, "sha256:test-pi");
  assert.deepEqual(spec?.args.slice(-2), ["--model", "claude-sonnet-4-6"]);
  await clock.fire(config.runner.idleTimeoutSeconds * 1000);
  assert.ok(calls.includes("pi:stop"));
  assert.ok(calls.includes("DELETE:/integral/internal/session"));
  await runner.stop();
});

test("[BOX-BE26C696] [BOX-C28F4A61] [FAILURE-071CB99A] [FAILURE-A4C19E72] runner releases claimed work and destroys a failed Pi runtime", async (t) => {
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
      newSessionIdentity: () => ({
        sessionId: "session-2",
        sessionToken: "token-2",
      }),
      writeMcpExtension: async () => undefined,
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

test("[SCHEDULE-033C050E] [SCHEDULE-930581F7] [SCHEDULE-81B854FB] task execution uses a fresh one-shot runtime and completes only after exit zero", async (t) => {
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
          return taskRuntime;
        },
      },
      clock: new ManualClock(),
      fetch: async () => new Response("ok"),
      async internalFetch(_paths, _caller, target, path, init) {
        calls.push(`${init?.method ?? "GET"}:${target}:${path}`);
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
      newSessionIdentity: () => ({
        sessionId: "task-session",
        sessionToken: "task-token",
      }),
      writeMcpExtension: async () => undefined,
      async writeEmailExtension(home, connections) {
        assert.equal(home, "/test/task-home");
        assert.deepEqual(
          connections.map((connection) => connection.name),
          ["mail"],
        );
        calls.push("task:email-tools");
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
      "task:create",
      "task:start",
      "task:prompt:perform scheduled work",
      "task:exit:0",
      "task:cleanup",
    ],
  );
  const completeIndex = calls.findIndex((call) => call.endsWith("/complete"));
  assert.ok(completeIndex > calls.indexOf("task:exit:0"));
  assert.ok(calls.includes("DELETE:gateway:/integral/internal/session"));
});
