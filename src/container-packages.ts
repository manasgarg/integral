import { atomicWrite, readText } from "./fs.ts";
import { IntegralError } from "./errors.ts";
import type { IntegralPaths } from "./paths.ts";

export const DEFAULT_CONTAINER_PACKAGES = [
  "ca-certificates",
  "gh",
  "git",
] as const;

export interface ContainerPackageState {
  revision: number;
  packages: string[];
}

export type ContainerPackageOperation = "install" | "upgrade";

const packageNamePattern = /^[a-z0-9][a-z0-9+.-]{0,99}$/;

export function validateContainerPackageNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20)
    throw new IntegralError(
      "packages must contain between 1 and 20 names",
      400,
    );
  const packages = value.map((entry) => {
    if (typeof entry !== "string" || !packageNamePattern.test(entry))
      throw new IntegralError(
        `invalid Debian package name: ${String(entry)}`,
        400,
      );
    return entry;
  });
  return [...new Set(packages)].sort();
}

export async function loadContainerPackageState(
  paths: IntegralPaths,
): Promise<ContainerPackageState> {
  const raw = await readText(paths.containerPackages);
  if (!raw)
    return { revision: 0, packages: [...DEFAULT_CONTAINER_PACKAGES].sort() };
  try {
    const parsed = JSON.parse(raw) as Partial<ContainerPackageState>;
    if (
      !Number.isInteger(parsed.revision) ||
      Number(parsed.revision) < 0 ||
      !Array.isArray(parsed.packages) ||
      parsed.packages.length < DEFAULT_CONTAINER_PACKAGES.length ||
      parsed.packages.length > 50 ||
      parsed.packages.some(
        (entry) => typeof entry !== "string" || !packageNamePattern.test(entry),
      ) ||
      DEFAULT_CONTAINER_PACKAGES.some(
        (required) => !parsed.packages!.includes(required),
      )
    )
      throw new Error("invalid package state");
    return {
      revision: Number(parsed.revision),
      packages: [...new Set(parsed.packages)].sort(),
    };
  } catch {
    throw new IntegralError(
      `container package state is invalid: ${paths.containerPackages}`,
    );
  }
}

export function planContainerPackageChange(
  current: ContainerPackageState,
  operation: ContainerPackageOperation,
  requested: string[],
  expectedRevision: number,
): ContainerPackageState | undefined {
  if (expectedRevision !== current.revision)
    throw new IntegralError(
      `container package revision conflict: expected ${expectedRevision}, current ${current.revision}`,
      409,
    );
  if (operation === "upgrade") {
    const unknown = requested.filter(
      (name) => !current.packages.includes(name),
    );
    if (unknown.length)
      throw new IntegralError(
        `cannot upgrade packages that are not installed: ${unknown.join(", ")}`,
        409,
      );
    return { revision: current.revision + 1, packages: [...current.packages] };
  }
  const packages = [...new Set([...current.packages, ...requested])].sort();
  if (packages.length > 50)
    throw new IntegralError("managed images support at most 50 packages", 400);
  if (packages.length === current.packages.length) return undefined;
  return { revision: current.revision + 1, packages };
}

export async function saveContainerPackageState(
  paths: IntegralPaths,
  state: ContainerPackageState,
): Promise<void> {
  await atomicWrite(paths.containerPackages, `${JSON.stringify(state)}\n`);
}
