import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { acquireLock } from "../src/fs.ts";
import { fixture } from "./helpers.ts";
import { componentIdentity, deploymentId, internalHeaders, readComponentState, verifyInternal, writeComponentState } from "../src/state.ts";
import { serverStatus } from "../src/server.ts";
import type { Component } from "../src/constants.ts";

test("[SERVER-DF5FD52E] component locks exclude duplicates only within one normalized deployment", async (t) => { const paths = await fixture(t), file = join(paths.locks, "coordinator.lock"), unlock = await acquireLock(file); t.after(unlock); await assert.rejects(acquireLock(file), { code: "EEXIST" }); });

test("[SERVER-A74F29C1] independent RR_HOME roots have independent locks, state, identity, and deployment IDs", async (t) => { const a = await fixture(t), b = await fixture(t), unlockA = await acquireLock(join(a.locks, "gateway.lock")), unlockB = await acquireLock(join(b.locks, "gateway.lock")); t.after(unlockA); t.after(unlockB); assert.notEqual(deploymentId(a), deploymentId(b)); assert.notEqual(await componentIdentity(a), await componentIdentity(b)); });

test("[SERVER-4E19B7A6] deployment-scoped component identity verifies caller, deployment, and token together", async (t) => { const paths = await fixture(t), token = await componentIdentity(paths), deployment = deploymentId(paths), headers = internalHeaders("runner", token, deployment); assert.equal(verifyInternal(headers, "runner", token, deployment), true); assert.equal(verifyInternal(headers, "gateway", token, deployment), false); assert.equal(verifyInternal(headers, "runner", "wrong", deployment), false); assert.equal(verifyInternal(headers, "runner", token, "other"), false); });

test("[SERVER-3B7F90C2] [CONFIG-35D8A2F1] aggregate health probes each component and degrades on fingerprint or generation mismatch", async (t) => { const paths = await fixture(t), deployment = deploymentId(paths);
  for (const component of ["coordinator", "runner", "gateway"] as Component[]) await writeComponentState(paths, { component, deploymentId: deployment, endpoint: `http://127.0.0.1:${component === "gateway" ? 7300 : component === "coordinator" ? 7301 : 7302}`, pid: process.pid, status: "ready", fingerprint: component === "runner" ? "different" : "same", connectionGeneration: 1, startedAt: new Date().toISOString() });
  const status = await serverStatus(paths, async () => true); assert.equal(status.overall, "degraded"); assert.deepEqual(Object.values(status.components).map((c) => c.status), ["ready", "ready", "ready"]);
});

test("[SERVER-51C9A3E8] [ENV-A4D8206F] state discovery accepts only the expected component and deployment", async (t) => { const paths = await fixture(t), deployment = deploymentId(paths); await writeComponentState(paths, { component: "coordinator", deploymentId: deployment, endpoint: "http://127.0.0.1:9999", pid: 1, status: "ready", fingerprint: "f", connectionGeneration: 0, startedAt: new Date().toISOString() }); assert.equal((await readComponentState(paths, "coordinator"))?.endpoint, "http://127.0.0.1:9999"); const raw = JSON.stringify({ component: "runner", deploymentId: deployment, endpoint: "bad" }); const { writeFile } = await import("node:fs/promises"); await writeFile(join(paths.componentState, "coordinator.json"), raw); assert.equal(await readComponentState(paths, "coordinator"), undefined); });

test("[SERVER-6F18C2D9] stale ready files cannot make a stopped component healthy", async (t) => { const paths = await fixture(t), deployment = deploymentId(paths); await writeComponentState(paths, { component: "gateway", deploymentId: deployment, endpoint: "http://127.0.0.1:1", pid: 1, status: "ready", fingerprint: "f", connectionGeneration: 0, startedAt: new Date().toISOString() }); const status = await serverStatus(paths, async () => false); assert.equal(status.overall, "stopped"); assert.equal(status.components.gateway.status, "stopped"); });

test("[SERVER-7C21D5E8] coordinator and runner component state publishes loopback endpoints", async (t) => { const paths = await fixture(t), deployment = deploymentId(paths); for (const component of ["coordinator", "runner"] as const) { await writeComponentState(paths, { component, deploymentId: deployment, endpoint: `http://127.0.0.1:${component === "coordinator" ? 7301 : 7302}`, pid: 1, status: "ready", fingerprint: "f", connectionGeneration: 0, startedAt: "now" }); assert.equal(new URL((await readComponentState(paths, component))!.endpoint).hostname, "127.0.0.1"); } });

test("[SERVER-0D7E29B5] [SERVER-8A31D6C4] combined and separate runtimes use the same HTTP component classes and ports", async () => { const source = await import("node:fs/promises").then((fs) => fs.readFile("src/server.ts", "utf8")); assert.match(source, /new Coordinator/); assert.match(source, /new Gateway/); assert.match(source, /new Runner/); assert.match(source, /runtime\.start/); assert.doesNotMatch(source, /coordinator\.queue\./); });

test("[SERVER-B4E20F76] [SERVER-6F18C2D9] missing sibling state is represented as degraded or stopped without mutating durable data", async (t) => { const paths = await fixture(t), status = await serverStatus(paths); assert.equal(status.overall, "stopped"); assert.deepEqual(Object.values(status.components).map((x) => x.status), ["stopped", "stopped", "stopped"]); });

test("[SERVER-C6A830F4] [LOG-E5A81D23] combined orchestration has reverse-order cleanup for every partially started component", async () => { const source = await import("node:fs/promises").then((fs) => fs.readFile("src/server.ts", "utf8")); assert.match(source, /started\.toReversed\(\)/); assert.match(source, /await stopAll\(\); throw error/); });

test("[SERVER-FE2BB5CF] [CONNECTION-20778353] only runner construction checks active model connection and Docker availability", async () => { const runner = await import("node:fs/promises").then((fs) => fs.readFile("src/runner.ts", "utf8")); const coordinator = await import("node:fs/promises").then((fs) => fs.readFile("src/coordinator.ts", "utf8")); const gateway = await import("node:fs/promises").then((fs) => fs.readFile("src/gateway.ts", "utf8")); assert.match(runner, /selectModel.*dockerAvailable/s); assert.doesNotMatch(coordinator + gateway, /dockerAvailable|selectModel/); });

test("[SERVER-33E00BBA] [SERVER-E3A74B10] clean shutdown removes only started component state and locks and stops owned runtimes", async () => { const source = await import("node:fs/promises").then((fs) => fs.readFile("src/server.ts", "utf8")); assert.match(source, /item\.stop/); assert.match(source, /componentStatePath\(paths, item\.component\)/); assert.match(source, /item\.unlock/); assert.match(source, /SIGINT/); assert.match(source, /SIGTERM/); });

test("[SERVER-F886D80C] server orchestration starts coordinator, gateway, and runner in one foreground promise", async () => { const source = await import("node:fs/promises").then((fs) => fs.readFile("src/server.ts", "utf8")); assert.match(source, /\["coordinator", "gateway", "runner"\]/); assert.match(source, /new Promise<void>/); });
