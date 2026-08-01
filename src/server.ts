import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Component } from "./constants.ts";
import { COMPONENTS } from "./constants.ts";
import type { EffectiveConfig } from "./config.ts";
import { acquireLock, readText } from "./fs.ts";
import type { RrPaths } from "./paths.ts";
import {
  componentStatePath,
  deploymentId,
  readComponentState,
  writeComponentState,
} from "./state.ts";
import { Coordinator } from "./coordinator.ts";
import { Gateway } from "./gateway.ts";
import { Runner, validateRunnerHost } from "./runner.ts";
import { Logger } from "./logging.ts";
import { RrError } from "./errors.ts";
import { credentialSecretValues } from "./connections.ts";

interface Started {
  component: Component;
  stop: () => Promise<void>;
  unlock: () => Promise<void>;
  logger: Logger;
}
export async function connectionGeneration(paths: RrPaths): Promise<number> {
  return Number(
    (await readText(join(paths.state, "connection-generation")))?.trim() || "0",
  );
}
function portFor(config: EffectiveConfig, component: Component): number {
  return config.server[`${component}Port`];
}

export async function startComponents(
  paths: RrPaths,
  config: EffectiveConfig,
  selected?: Component,
): Promise<void> {
  const components = selected
    ? [selected]
    : (["coordinator", "gateway", "runner"] satisfies Component[]);
  const started: Started[] = [],
    secrets = await credentialSecretValues(paths);
  if (components.includes("runner")) await validateRunnerHost(paths, config);
  const stopAll = async () => {
    for (const item of started.toReversed()) {
      try {
        await item.stop();
        item.logger.event("info", "component.lifecycle", "component stopped", {
          old_state: "ready",
          new_state: "stopped",
        });
      } catch (error) {
        item.logger.event(
          "error",
          "component.cleanup_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      await rm(componentStatePath(paths, item.component), { force: true });
      try {
        await item.unlock();
      } catch (error) {
        item.logger.event(
          "error",
          "component.cleanup_failed",
          error instanceof Error ? error.message : String(error),
          { resource: "lock" },
        );
      }
    }
  };
  try {
    for (const component of components) {
      let unlock: () => Promise<void>;
      try {
        unlock = await acquireLock(join(paths.locks, `${component}.lock`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new RrError(`${component} component lock is already held`);
        throw error;
      }
      const logger = new Logger({
        component,
        deploymentId: deploymentId(paths),
        level: config.logging.level,
        format: config.logging.format,
        secrets,
      });
      logger.event("info", "component.lifecycle", "component starting", {
        old_state: "stopped",
        new_state: "starting",
      });
      let runtime: Coordinator | Gateway | Runner;
      try {
        runtime =
          component === "coordinator"
            ? new Coordinator(paths, config)
            : component === "gateway"
              ? new Gateway(paths, config, logger)
              : new Runner(paths, config, logger);
        await runtime.start();
      } catch (error) {
        logger.event(
          "error",
          "component.start_failed",
          error instanceof Error ? error.message : String(error),
          { old_state: "starting", new_state: "failed" },
        );
        await unlock();
        throw error;
      }
      const stop = () => runtime.stop();
      started.push({ component, stop, unlock, logger });
      const generation = await connectionGeneration(paths);
      await writeComponentState(paths, {
        component,
        deploymentId: deploymentId(paths),
        endpoint: `http://127.0.0.1:${portFor(config, component)}`,
        pid: process.pid,
        status: "ready",
        fingerprint: config.fingerprint,
        connectionGeneration: generation,
        startedAt: new Date().toISOString(),
      });
      logger.event("info", "component.lifecycle", "component ready", {
        old_state: "starting",
        new_state: "ready",
        address: `127.0.0.1:${portFor(config, component)}`,
      });
    }
  } catch (error) {
    await stopAll();
    throw error;
  }
  await new Promise<void>((resolve) => {
    let stopping = false;
    const signal = () => {
      if (stopping) return;
      stopping = true;
      void stopAll().then(resolve);
    };
    process.once("SIGINT", signal);
    process.once("SIGTERM", signal);
  });
}

export interface DeploymentStatus {
  overall: "healthy" | "degraded" | "stopped";
  components: Record<
    Component,
    {
      status: string;
      endpoint?: string;
      pid?: number;
      fingerprint?: string;
      connectionGeneration?: number;
    }
  >;
}
export async function serverStatus(
  paths: RrPaths,
  probe: (
    endpoint: string,
    component: Component,
    deployment: string,
  ) => Promise<boolean> = probeComponent,
): Promise<DeploymentStatus> {
  const recorded = await Promise.all(
    COMPONENTS.map((component) => readComponentState(paths, component)),
  );
  const entries = await Promise.all(
    recorded.map(async (state, i) => {
      if (!state) return undefined;
      return (await probe(state.endpoint, COMPONENTS[i]!, deploymentId(paths)))
        ? state
        : undefined;
    }),
  );
  const components = Object.fromEntries(
    COMPONENTS.map((component, i) => [
      component,
      entries[i]
        ? {
            status: entries[i].status,
            endpoint: entries[i].endpoint,
            pid: entries[i].pid,
            fingerprint: entries[i].fingerprint,
            connectionGeneration: entries[i].connectionGeneration,
          }
        : { status: "stopped" },
    ]),
  ) as DeploymentStatus["components"];
  const running = entries.filter(Boolean);
  const fingerprints = new Set(running.map((s) => s!.fingerprint)),
    generations = new Set(running.map((s) => s!.connectionGeneration));
  const overall =
    running.length === 0
      ? "stopped"
      : running.length === 3 &&
          fingerprints.size === 1 &&
          generations.size === 1 &&
          running.every((s) => s!.status === "ready")
        ? "healthy"
        : "degraded";
  return { overall, components };
}
async function probeComponent(
  endpoint: string,
  component: Component,
  deployment: string,
): Promise<boolean> {
  try {
    const response = await fetch(new URL("/rr/health", endpoint), {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      component?: string;
      deploymentId?: string;
    };
    return body.component === component && body.deploymentId === deployment;
  } catch {
    return false;
  }
}
