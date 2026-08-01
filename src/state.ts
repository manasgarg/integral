import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import { open } from "node:fs/promises";
import type { Component } from "./constants.ts";
import type { IntegralPaths } from "./paths.ts";

export interface ComponentState {
  component: Component;
  deploymentId: string;
  endpoint: string;
  pid: number;
  status: "ready" | "degraded";
  fingerprint: string;
  connectionGeneration: number;
  startedAt: string;
  error?: string;
}

export function deploymentId(paths: IntegralPaths): string {
  return createHash("sha256").update(paths.root).digest("hex").slice(0, 20);
}
export function componentStatePath(
  paths: IntegralPaths,
  component: Component,
): string {
  return join(paths.componentState, `${component}.json`);
}
export async function writeComponentState(
  paths: IntegralPaths,
  state: ComponentState,
): Promise<void> {
  await atomicWrite(
    componentStatePath(paths, state.component),
    `${JSON.stringify(state)}\n`,
  );
}
export async function readComponentState(
  paths: IntegralPaths,
  component: Component,
): Promise<ComponentState | undefined> {
  const raw = await readText(componentStatePath(paths, component));
  if (!raw) return undefined;
  try {
    const state = JSON.parse(raw) as ComponentState;
    return state.component === component &&
      state.deploymentId === deploymentId(paths)
      ? state
      : undefined;
  } catch {
    return undefined;
  }
}
export async function updateComponentState(
  paths: IntegralPaths,
  component: Component,
  patch: Partial<
    Pick<ComponentState, "status" | "connectionGeneration" | "error">
  >,
): Promise<void> {
  const current = await readComponentState(paths, component);
  if (!current || current.pid !== process.pid) return;
  const next = { ...current, ...patch };
  if (patch.error === undefined) delete next.error;
  await writeComponentState(paths, next);
}

export async function componentIdentity(paths: IntegralPaths): Promise<string> {
  const file = join(paths.state, "component-identity");
  const existing = (await readText(file))?.trim();
  if (existing) return existing;
  const created = randomBytes(32).toString("base64url");
  await ensureDir(paths.state);
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(`${created}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return (await readText(file))!.trim();
    throw error;
  }
  return created;
}
export function internalHeaders(
  component: Component,
  token: string,
  deployment: string,
): Record<string, string> {
  return {
    "x-integral-component": component,
    "x-integral-deployment": deployment,
    authorization: `Bearer ${token}`,
  };
}
export function verifyInternal(
  headers: Record<string, string | string[] | undefined>,
  expectedCaller: Component | Component[],
  token: string,
  deployment: string,
): boolean {
  const callers = Array.isArray(expectedCaller)
    ? expectedCaller
    : [expectedCaller];
  return (
    callers.includes(headers["x-integral-component"] as Component) &&
    headers["x-integral-deployment"] === deployment &&
    headers.authorization === `Bearer ${token}`
  );
}
