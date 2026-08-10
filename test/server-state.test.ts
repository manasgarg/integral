import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type http from "node:http";
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
import { nodeHttpServerRuntime } from "../src/runtime.ts";
import type { Component } from "../src/constants.ts";
import { requireActiveModelConnection } from "../src/runner.ts";

/* @covers SERVER-DF5FD52E
Given a server component is running for a deployment
	When another process starts that same component with the same `$INTEGRAL_HOME`
		Then the second process exits non-zero
			And reports that the component lock is already held
			And does not disturb any running component
	When the lock file names a process that no longer exists
		Then integral removes the stale lock
			And lets the new component acquire it
*/
test("[SERVER-DF5FD52E] component locks exclude duplicates only within one normalized deployment", async (t) => {
  const paths = await fixture(t),
    file = join(paths.locks, "coordinator.lock"),
    unlock = await acquireLock(file);
  t.after(unlock);
  await assert.rejects(acquireLock(file), { code: "EEXIST" });
});

/* @covers SERVER-A74F29C1
Given two integral deployments use different `$INTEGRAL_HOME` roots
	And all component ports are distinct within and across the two deployments
	When the user starts both servers
		Then both servers become healthy
			And each component holds a lock only within its own `$INTEGRAL_HOME`
			And each server uses only its own configuration and credentials
			And each server uses its own CA, state, session tokens, network, and containers
			And stopping one server does not disturb the other
*/
test("[SERVER-A74F29C1] independent INTEGRAL_HOME roots have independent locks, state, identity, and deployment IDs", async (t) => {
  const a = await fixture(t),
    b = await fixture(t),
    unlockA = await acquireLock(join(a.locks, "gateway.lock")),
    unlockB = await acquireLock(join(b.locks, "gateway.lock"));
  t.after(unlockA);
  t.after(unlockB);
  assert.notEqual(deploymentId(a), deploymentId(b));
  assert.notEqual(await componentIdentity(a), await componentIdentity(b));
});

/* @covers SERVER-4E19B7A6
Given server components communicate over their distinct listeners
	When a component sends an internal request
		Then it sends a shared deployment-scoped bearer identity
			And identifies the calling component in a separate header
			And the receiver verifies the bearer identity, expected deployment, and expected caller
	When a request has missing, invalid, or cross-deployment component identity
		Then the receiving component refuses it without changing state
*/
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

/* @covers SERVER-3B7F90C2
Given one or more server components are running
	When the user runs `integral server status`
		Then integral probes each recorded health endpoint with a bounded timeout
			And treats missing, unreachable, or identity-mismatched endpoints as stopped
			And reports coordinator, runner, gateway, and scheduler health separately
			And reports whether the deployment is healthy or degraded overall
			And produces the same status model in combined and separate modes
			And exits successfully only when the overall deployment is healthy
	When the user runs `integral server status --json`
		Then integral returns the same overall and component status as structured JSON
Given no recorded component answers a valid health probe
	When the user runs `integral server status`
		Then integral reports the deployment and all four components as stopped
			And exits non-zero
*/
test("[SERVER-3B7F90C2] [CONFIG-35D8A2F1] aggregate health probes each component and degrades on fingerprint or generation mismatch", async (t) => {
  const paths = await fixture(t),
    deployment = deploymentId(paths);
  for (const component of [
    "coordinator",
    "runner",
    "gateway",
    "scheduler",
  ] as Component[])
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: `http://127.0.0.1:${component === "gateway" ? 7310 : component === "coordinator" ? 7311 : component === "runner" ? 7312 : 7313}`,
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
    ["ready", "ready", "ready", "ready"],
  );
});

/* @covers SERVER-51C9A3E8
Given one component has published its endpoint under an `$INTEGRAL_HOME`
	When another component starts with that same `$INTEGRAL_HOME`
		Then it discovers the published endpoint from deployment state
			And verifies the endpoint belongs to the expected deployment and component
			And does not require component endpoint arguments to be repeated
*/
/* @covers ENV-A4D8206F
Given a healthy coordinator recorded its endpoint under an `INTEGRAL_HOME`
	When the user runs `integral talk` or another coordinator client with that same `INTEGRAL_HOME`
		Then the client uses the recorded coordinator endpoint
			And does not require `INTEGRAL_COORDINATOR_PORT` to be repeated
			And verifies the endpoint belongs to the expected deployment and component
*/
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

/* @covers SERVER-6F18C2D9
Given coordinator, runner, gateway, and scheduler run in separate processes
	When one component exits
		Then the other component processes remain running
			And their health reports identify the missing dependency
			And acknowledged queue and conversation state remain durable
*/
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

/* @covers SERVER-7C21D5E8
Given integral starts the server components
	When it binds their listeners
		Then the coordinator, runner, and scheduler listen on loopback only
			And the gateway initially listens on loopback
			And the runner asks it to add the deployment Docker-network gateway address
			And no component listens on every host interface by default
*/
test("[SERVER-7C21D5E8] coordinator, runner, and scheduler component state publishes loopback endpoints", async (t) => {
  const paths = await fixture(t),
    deployment = deploymentId(paths);
  for (const component of ["coordinator", "runner", "scheduler"] as const) {
    await writeComponentState(paths, {
      component,
      deploymentId: deployment,
      endpoint: `http://127.0.0.1:${component === "coordinator" ? 7311 : component === "runner" ? 7312 : 7313}`,
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

/* @covers SERVER-F886D80C
Given Docker is available
	And at least one active model connection exists
	And no server component is running for this deployment
	When the user runs `integral server start`
		Then integral validates that an active model connection and the Docker daemon are available before starting listeners
			And does not select a model connection or model
			And starts the coordinator, scheduler, gateway, and runner in that order in one process
			And each component listens on its own configured port
			And publishes each component as ready after its listener starts
			And reports the deployment healthy only when all four ready states agree
			And remains in the foreground until interrupted
*/
/* @covers SERVER-0D7E29B5
Given integral is running all components in one process
	When a component calls another component
		Then it uses the same authenticated network interface used in separate mode
			And does not replace the component boundary with direct in-memory calls
			And each component remains independently health-checkable on its own port
*/
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
          (["coordinator", "scheduler", "gateway", "runner"] as const).map(
            (component) => readComponentState(paths, component),
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
    "create:scheduler",
    "start:scheduler",
    "create:gateway",
    "start:gateway",
    "create:runner",
    "start:runner",
    "ready",
    "stop:runner",
    "stop:gateway",
    "stop:scheduler",
    "stop:coordinator",
  ]);
  for (const component of [
    "coordinator",
    "scheduler",
    "gateway",
    "runner",
  ] as const) {
    assert.equal(await readComponentState(paths, component), undefined);
    const unlock = await acquireLock(join(paths.locks, `${component}.lock`));
    await unlock();
  }
});

/* @covers SERVER-B4E20F76
Given the four components will run as separate processes
	When the coordinator starts before the runner, gateway, or scheduler
		Then it becomes available for terminal attachment and durable queue mutations
			And reports unavailable dependencies as degraded
	When the runner starts before the gateway
		Then it does not claim queued messages or tasks until governed egress is healthy
	When the scheduler starts before the coordinator
		Then it retains due occurrences until the coordinator becomes available
	When missing components later become healthy
		Then the deployment begins processing queued messages without restarting healthy components
*/
test("[SERVER-B4E20F76] [SERVER-6F18C2D9] missing sibling state is represented as degraded or stopped without mutating durable data", async (t) => {
  const paths = await fixture(t),
    status = await serverStatus(paths);
  assert.equal(status.overall, "stopped");
  assert.deepEqual(
    Object.values(status.components).map((x) => x.status),
    ["stopped", "stopped", "stopped", "stopped"],
  );
});

/* @covers SERVER-C6A830F4
Given integral is starting all components in one process
	When any component cannot bind, validate, or become ready
		Then the process stops every component it started
			And removes every ready-state record and lock it created
			And exits non-zero without reporting the deployment healthy
*/
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
    "create:scheduler",
    "start:scheduler",
    "create:gateway",
    "start:gateway",
    "stop:gateway",
    "stop:scheduler",
    "stop:coordinator",
  ]);
  for (const component of ["coordinator", "gateway"] as const) {
    assert.equal(await readComponentState(paths, component), undefined);
    const unlock = await acquireLock(join(paths.locks, `${component}.lock`));
    await unlock();
  }
});

/* @covers SERVER-FE2BB5CF
Given the Docker daemon cannot be reached
	When the user runs `integral server start`
		Then startup exits non-zero
			And identifies Docker as unavailable
			And does not publish gateway-ready state
	When the user starts only the runner component
		Then the runner exits non-zero and identifies Docker as unavailable
	When the user starts only the coordinator, gateway, or scheduler component
		Then that component may become healthy without Docker
*/
/* @covers CONNECTION-20778353
Given no active model connection is configured
	When the user runs `integral server start`
		Then the server exits non-zero
			And does not accept chat sessions
			And instructs the user to run `integral connection add`
			And does not start a container
	When the user starts only the runner component
		Then the runner exits non-zero with the same connection instruction
	When the user starts only the coordinator or gateway component
		Then that component is not refused solely because the model connection is absent
*/
test("[SERVER-F886D80C] [SERVER-FE2BB5CF] [CONNECTION-20778353] runner startup preflights connection availability and Docker without selecting a model", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = { ...base, logging: { ...base.logging, level: "error" as const } };
  for (const component of [
    "coordinator",
    "gateway",
    "runner",
    "scheduler",
  ] as const) {
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

test("[SERVER-F886D80C] [CONNECTION-20778353] startup requires one active model connection but accepts several without selecting one", () => {
  const connection = {
    name: "anthropic",
    kind: "model",
    provider: "anthropic",
    auth: "key",
    state: "active",
  } as const;
  assert.throws(
    () => requireActiveModelConnection([]),
    /no active model connection.*integral connection add/,
  );
  assert.doesNotThrow(() => requireActiveModelConnection([connection]));
  assert.doesNotThrow(() =>
    requireActiveModelConnection([
      connection,
      { ...connection, name: "second" },
    ]),
  );
});

/* @covers SERVER-33E00BBA
Given all components are running in one foreground process
	When it receives SIGINT or SIGTERM
		Then it stops owned components in reverse startup order
			And stops all four component listeners
			And durably returns any interrupted in-flight message to the queue
			And terminates any active chat or task container
			And revokes temporary session identity material
			And removes its lock and ready-state files
			And exits without leaving a integral container running
*/
/* @covers SERVER-E3A74B10
Given coordinator, runner, gateway, and scheduler run in separate processes
	When the runner stops
		Then it durably returns any interrupted in-flight message to the coordinator queue
			And resolves any interrupted task according to its trigger's recovery policy
			And terminates every Pi container it owns
			And does not stop the coordinator, gateway, or scheduler
	When the coordinator, gateway, or scheduler stops
		Then it does not signal the other component processes to exit
	When any separate component stops cleanly
		Then it removes only its own ready-state record and component lock
*/
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

test("[SERVER-33E00BBA] shutdown closes active connections after refusing new ones", async () => {
  const events: string[] = [];
  let closed: ((error?: Error) => void) | undefined;
  const server = {
    close(callback: (error?: Error) => void) {
      events.push("close");
      closed = callback;
      return server;
    },
    closeAllConnections() {
      events.push("close-all");
      closed?.();
    },
  } as unknown as http.Server;

  await nodeHttpServerRuntime.close(server);

  assert.deepEqual(events, ["close", "close-all"]);
});
