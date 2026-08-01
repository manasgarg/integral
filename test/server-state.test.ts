import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { acquireLock } from "../src/fs.ts";
import { loadConfig } from "../src/config.ts";
import { fixture } from "./helpers.ts";
import {
  componentIdentity,
  deploymentId,
  internalHeaders,
  readComponentState,
  verifyInternal,
  writeComponentState,
} from "../src/state.ts";
import {
  serverStatus,
  startComponents,
  waitForShutdownSignal,
  type StartComponentsDependencies,
} from "../src/server.ts";
import type { Component } from "../src/constants.ts";

test("[SERVER-DF5FD52E] component locks exclude duplicates only within one normalized deployment", async (t) => {
  const paths = await fixture(t),
    file = join(paths.locks, "coordinator.lock"),
    unlock = await acquireLock(file);
  t.after(unlock);
  await assert.rejects(acquireLock(file), { code: "EEXIST" });
});

test("[SERVER-A74F29C1] independent RR_HOME roots have independent locks, state, identity, and deployment IDs", async (t) => {
  const a = await fixture(t),
    b = await fixture(t),
    unlockA = await acquireLock(join(a.locks, "gateway.lock")),
    unlockB = await acquireLock(join(b.locks, "gateway.lock"));
  t.after(unlockA);
  t.after(unlockB);
  assert.notEqual(deploymentId(a), deploymentId(b));
  assert.notEqual(await componentIdentity(a), await componentIdentity(b));
});

test("[SERVER-4E19B7A6] deployment-scoped component identity verifies caller, deployment, and token together", async (t) => {
  const paths = await fixture(t),
    token = await componentIdentity(paths),
    deployment = deploymentId(paths),
    headers = internalHeaders("runner", token, deployment);
  assert.equal(verifyInternal(headers, "runner", token, deployment), true);
  assert.equal(verifyInternal(headers, "gateway", token, deployment), false);
  assert.equal(verifyInternal(headers, "runner", "wrong", deployment), false);
  assert.equal(verifyInternal(headers, "runner", token, "other"), false);
});

test("[SERVER-3B7F90C2] [CONFIG-35D8A2F1] aggregate health probes each component and degrades on fingerprint or generation mismatch", async (t) => {
  const paths = await fixture(t),
    deployment = deploymentId(paths);
  for (const component of ["coordinator", "runner", "gateway"] as Component[])
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: `http://127.0.0.1:${component === "gateway" ? 7300 : component === "coordinator" ? 7301 : 7302}`,
      pid: process.pid,
      status: "ready",
      fingerprint: component === "runner" ? "different" : "same",
      connectionGeneration: 1,
      startedAt: new Date().toISOString(),
    });
  const status = await serverStatus(paths, async () => true);
  assert.equal(status.overall, "degraded");
  assert.deepEqual(
    Object.values(status.components).map((c) => c.status),
    ["ready", "ready", "ready"],
  );
});

test("[SERVER-51C9A3E8] [ENV-A4D8206F] state discovery accepts only the expected component and deployment", async (t) => {
  const paths = await fixture(t),
    deployment = deploymentId(paths);
  await writeComponentState(paths, {
    component: "coordinator",
    deploymentId: deployment,
    endpoint: "http://127.0.0.1:9999",
    pid: 1,
    status: "ready",
    fingerprint: "f",
    connectionGeneration: 0,
    startedAt: new Date().toISOString(),
  });
  assert.equal(
    (await readComponentState(paths, "coordinator"))?.endpoint,
    "http://127.0.0.1:9999",
  );
  const raw = JSON.stringify({
    component: "runner",
    deploymentId: deployment,
    endpoint: "bad",
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(paths.componentState, "coordinator.json"), raw);
  assert.equal(await readComponentState(paths, "coordinator"), undefined);
});

test("[SERVER-6F18C2D9] stale ready files cannot make a stopped component healthy", async (t) => {
  const paths = await fixture(t),
    deployment = deploymentId(paths);
  await writeComponentState(paths, {
    component: "gateway",
    deploymentId: deployment,
    endpoint: "http://127.0.0.1:1",
    pid: 1,
    status: "ready",
    fingerprint: "f",
    connectionGeneration: 0,
    startedAt: new Date().toISOString(),
  });
  const status = await serverStatus(paths, async () => false);
  assert.equal(status.overall, "stopped");
  assert.equal(status.components.gateway.status, "stopped");
});

test("[SERVER-7C21D5E8] coordinator and runner component state publishes loopback endpoints", async (t) => {
  const paths = await fixture(t),
    deployment = deploymentId(paths);
  for (const component of ["coordinator", "runner"] as const) {
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: `http://127.0.0.1:${component === "coordinator" ? 7301 : 7302}`,
      pid: 1,
      status: "ready",
      fingerprint: "f",
      connectionGeneration: 0,
      startedAt: "now",
    });
    assert.equal(
      new URL((await readComponentState(paths, component))!.endpoint).hostname,
      "127.0.0.1",
    );
  }
});

test("[SERVER-F886D80C] [SERVER-0D7E29B5] combined orchestration starts every component, publishes readiness, and stops in reverse order", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = { ...base, logging: { ...base.logging, level: "error" as const } },
    events: string[] = [];
  let observedReady = false;
  const dependencies: StartComponentsDependencies = {
    async validateRunnerHost() {
      events.push("preflight:runner");
    },
    createRuntime(component) {
      events.push(`create:${component}`);
      return {
        async start() {
          events.push(`start:${component}`);
        },
        async stop() {
          events.push(`stop:${component}`);
        },
      };
    },
    async waitForShutdown(stop) {
      events.push("ready");
      observedReady = (
        await Promise.all(
          (["coordinator", "gateway", "runner"] as const).map((component) =>
            readComponentState(paths, component),
          ),
        )
      ).every((state) => state?.status === "ready");
      await stop();
    },
  };

  await startComponents(paths, config, undefined, dependencies);

  assert.equal(observedReady, true);
  assert.deepEqual(events, [
    "preflight:runner",
    "create:coordinator",
    "start:coordinator",
    "create:gateway",
    "start:gateway",
    "create:runner",
    "start:runner",
    "ready",
    "stop:runner",
    "stop:gateway",
    "stop:coordinator",
  ]);
  for (const component of ["coordinator", "gateway", "runner"] as const) {
    assert.equal(await readComponentState(paths, component), undefined);
    const unlock = await acquireLock(join(paths.locks, `${component}.lock`));
    await unlock();
  }
});

test("[SERVER-B4E20F76] [SERVER-6F18C2D9] missing sibling state is represented as degraded or stopped without mutating durable data", async (t) => {
  const paths = await fixture(t),
    status = await serverStatus(paths);
  assert.equal(status.overall, "stopped");
  assert.deepEqual(
    Object.values(status.components).map((x) => x.status),
    ["stopped", "stopped", "stopped"],
  );
});

test("[SERVER-C6A830F4] [LOG-E5A81D23] partial startup failure cleans the failing runtime and every earlier component", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = { ...base, logging: { ...base.logging, level: "error" as const } },
    events: string[] = [];
  await assert.rejects(
    startComponents(paths, config, undefined, {
      async validateRunnerHost() {},
      createRuntime(component) {
        events.push(`create:${component}`);
        return {
          async start() {
            events.push(`start:${component}`);
            if (component === "gateway") throw new Error("cannot bind");
          },
          async stop() {
            events.push(`stop:${component}`);
          },
        };
      },
      async waitForShutdown() {
        assert.fail("failed startup must not wait for shutdown");
      },
    }),
    /cannot bind/,
  );
  assert.deepEqual(events, [
    "create:coordinator",
    "start:coordinator",
    "create:gateway",
    "start:gateway",
    "stop:gateway",
    "stop:coordinator",
  ]);
  for (const component of ["coordinator", "gateway"] as const) {
    assert.equal(await readComponentState(paths, component), undefined);
    const unlock = await acquireLock(join(paths.locks, `${component}.lock`));
    await unlock();
  }
});

test("[SERVER-FE2BB5CF] [CONNECTION-20778353] runner selection alone performs model and Docker preflight", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = { ...base, logging: { ...base.logging, level: "error" as const } };
  for (const component of ["coordinator", "gateway", "runner"] as const) {
    let preflights = 0,
      created: Component | undefined;
    await startComponents(paths, config, component, {
      async validateRunnerHost() {
        preflights++;
      },
      createRuntime(value) {
        created = value;
        return { async start() {}, async stop() {} };
      },
      async waitForShutdown(stop) {
        await stop();
      },
    });
    assert.equal(created, component);
    assert.equal(preflights, component === "runner" ? 1 : 0);
  }
});

test("[SERVER-33E00BBA] [SERVER-E3A74B10] the production signal waiter stops once and removes both signal listeners", async () => {
  const signals = new EventEmitter(),
    events: string[] = [],
    waiting = waitForShutdownSignal(async () => {
      events.push("stop");
    }, signals);
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  await waiting;
  assert.deepEqual(events, ["stop"]);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
