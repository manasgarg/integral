import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContainerBackend,
  ContainerSpec,
  PiRuntime,
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
      endpoint: `http://127.0.0.1:${component === "gateway" ? 7300 : component === "coordinator" ? 7301 : 7302}`,
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
        if (path === "/rr/internal/claim") {
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
      listen: async () => undefined,
      close: async () => undefined,
    },
  );
  await runner.start();
  await runner.runOnce();
  await runner.runOnce();

  assert.equal(calls.filter((call) => call === "pi:create").length, 1);
  assert.ok(calls.includes("pi:prompt:hello"));
  await clock.fire(config.runner.idleTimeoutSeconds * 1000);
  assert.ok(calls.includes("pi:stop"));
  assert.ok(calls.includes("DELETE:/rr/internal/session"));
  await runner.stop();
});

test("[BOX-BE26C696] [BOX-C28F4A61] [FAILURE-071CB99A] runner releases claimed work and destroys a failed Pi runtime", async (t) => {
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
        throw new Error("gateway connection lost");
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
        ensureImage() {},
        async ensureNetwork() {},
        networkGateway: () => "127.0.0.1",
        createPi: () => pi,
      },
      clock: new ManualClock(),
      fetch: async () => new Response("ok"),
      async internalFetch(_paths, _caller, _target, path) {
        calls.push(path);
        if (path === "/rr/internal/claim")
          return Response.json({
            message: {
              id: "message-2",
              text: "fail",
              order: 1,
              status: "in-flight",
              attempts: 1,
              createdAt: "now",
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
      listen: async () => undefined,
      close: async () => undefined,
    },
  );

  await runner.runOnce();

  assert.ok(calls.includes("/rr/internal/work/message-2/release"));
  assert.ok(calls.includes("pi:stop"));
  assert.ok(calls.includes("/rr/internal/session"));
});
