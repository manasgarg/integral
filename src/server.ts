import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Component } from "./constants.ts";
import { COMPONENTS } from "./constants.ts";
import type { EffectiveConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { acquireLock, readText } from "./fs.ts";
import type { RrPaths } from "./paths.ts";
import { componentStatePath, deploymentId, readComponentState, writeComponentState } from "./state.ts";
import { Coordinator } from "./coordinator.ts";
import { Gateway } from "./gateway.ts";
import { Runner } from "./runner.ts";
import { Logger } from "./logging.ts";
import { RrError } from "./errors.ts";

interface Started { component: Component; stop: () => Promise<void>; unlock: () => Promise<void> }
export async function connectionGeneration(paths: RrPaths): Promise<number> { return Number((await readText(join(paths.state, "connection-generation")))?.trim() || "0"); }
function portFor(config: EffectiveConfig, component: Component): number { return config.server[`${component}Port`]; }

export async function startComponents(paths: RrPaths, config: EffectiveConfig, selected?: Component): Promise<void> {
  const components = selected ? [selected] : (["coordinator", "gateway", "runner"] satisfies Component[]); const started: Started[] = [];
  const stopAll = async () => { for (const item of started.toReversed()) { await item.stop().catch(() => undefined); await rm(componentStatePath(paths, item.component), { force: true }); await item.unlock().catch(() => undefined); } };
  try {
    for (const component of components) {
      let unlock: () => Promise<void>;
      try { unlock = await acquireLock(join(paths.locks, `${component}.lock`)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RrError(`${component} component lock is already held`); throw error; }
      const logger = new Logger({ component, deploymentId: deploymentId(paths), level: config.logging.level, format: config.logging.format });
      logger.event("info", "component.lifecycle", "component starting", { old_state: "stopped", new_state: "starting" });
      let runtime: Coordinator | Gateway | Runner;
      try { runtime = component === "coordinator" ? new Coordinator(paths, config, logger) : component === "gateway" ? new Gateway(paths, config, logger) : new Runner(paths, config, logger); await runtime.start(); }
      catch (error) { await unlock(); throw error; }
      const stop = () => runtime.stop(); started.push({ component, stop, unlock });
      const generation = await connectionGeneration(paths); await writeComponentState(paths, { component, deploymentId: deploymentId(paths), endpoint: `http://127.0.0.1:${portFor(config, component)}`, pid: process.pid, status: "ready", fingerprint: config.fingerprint, connectionGeneration: generation, startedAt: new Date().toISOString() });
      logger.event("info", "component.lifecycle", "component ready", { old_state: "starting", new_state: "ready", address: `127.0.0.1:${portFor(config, component)}` });
    }
  } catch (error) { await stopAll(); throw error; }
  await new Promise<void>((resolve) => {
    let stopping = false; const signal = () => { if (stopping) return; stopping = true; void stopAll().then(resolve); };
    process.once("SIGINT", signal); process.once("SIGTERM", signal);
  });
}

export interface DeploymentStatus { overall: "healthy" | "degraded" | "stopped"; components: Record<Component, { status: string; endpoint?: string; pid?: number; fingerprint?: string; connectionGeneration?: number }> }
export async function serverStatus(paths: RrPaths): Promise<DeploymentStatus> {
  const entries = await Promise.all(COMPONENTS.map((component) => readComponentState(paths, component))); const components = Object.fromEntries(COMPONENTS.map((component, i) => [component, entries[i] ? { status: entries[i]!.status, endpoint: entries[i]!.endpoint, pid: entries[i]!.pid, fingerprint: entries[i]!.fingerprint, connectionGeneration: entries[i]!.connectionGeneration } : { status: "stopped" }])) as DeploymentStatus["components"];
  const running = entries.filter(Boolean); const fingerprints = new Set(running.map((s) => s!.fingerprint)), generations = new Set(running.map((s) => s!.connectionGeneration));
  const overall = running.length === 0 ? "stopped" : running.length === 3 && fingerprints.size === 1 && generations.size === 1 && running.every((s) => s!.status === "ready") ? "healthy" : "degraded";
  return { overall, components };
}
