import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_PACKAGE } from "./constants.ts";
import { RrError } from "./errors.ts";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import type { RrPaths } from "./paths.ts";

export interface PiRuntimeResolution {
  version: string;
  packageRoot: string;
  warning?: string;
}

interface PiRuntimeState {
  version: string;
}

export interface PiPackageOperations {
  latestVersion(): string;
  install(prefix: string, version: string): void;
}

const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

const productionOperations: PiPackageOperations = {
  latestVersion() {
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["view", PI_PACKAGE, "version", "--json"],
      { encoding: "utf8", env: process.env },
    );
    if (result.status !== 0)
      throw new Error(result.stderr.trim() || "npm registry request failed");
    const parsed = JSON.parse(result.stdout) as unknown;
    if (typeof parsed !== "string" || !versionPattern.test(parsed))
      throw new Error("npm registry returned an invalid Pi version");
    return parsed;
  },
  install(prefix, version) {
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-save",
        "--package-lock=false",
        `${PI_PACKAGE}@${version}`,
      ],
      { encoding: "utf8", env: process.env },
    );
    if (result.status !== 0)
      throw new RrError(
        `cannot install Pi ${version}: ${result.stderr.trim() || "npm failed"}`,
      );
  },
};

function versionRoot(paths: RrPaths, version: string): string {
  return join(paths.piRuntime, "versions", version);
}

function packageRoot(prefix: string): string {
  return join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
}

async function installedVersion(prefix: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(packageRoot(prefix), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

async function cachedState(
  paths: RrPaths,
): Promise<PiRuntimeState | undefined> {
  try {
    const raw = await readText(paths.piRuntimeState);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<PiRuntimeState>;
    if (
      typeof parsed.version !== "string" ||
      !versionPattern.test(parsed.version)
    )
      return undefined;
    const prefix = versionRoot(paths, parsed.version);
    return (await installedVersion(prefix)) === parsed.version
      ? { version: parsed.version }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function ensurePiRuntime(
  paths: RrPaths,
  operations: PiPackageOperations = productionOperations,
): Promise<PiRuntimeResolution> {
  const cached = await cachedState(paths);
  let version: string;
  try {
    version = operations.latestVersion();
  } catch (error) {
    if (!cached)
      throw new RrError(
        `cannot check for the latest Pi version and no cached Pi runtime is available: ${error instanceof Error ? error.message : String(error)}`,
      );
    return {
      version: cached.version,
      packageRoot: packageRoot(versionRoot(paths, cached.version)),
      warning: `could not check for a newer Pi version; using cached Pi ${cached.version}`,
    };
  }
  if (!versionPattern.test(version))
    throw new RrError(
      `npm registry returned an invalid Pi version: ${version}`,
    );
  const prefix = versionRoot(paths, version);
  if ((await installedVersion(prefix)) !== version) {
    await ensureDir(prefix);
    operations.install(prefix, version);
    if ((await installedVersion(prefix)) !== version)
      throw new RrError(`Pi ${version} installation is incomplete`);
  }
  await atomicWrite(paths.piRuntimeState, `${JSON.stringify({ version })}\n`);
  return { version, packageRoot: packageRoot(prefix) };
}

export interface PiRuntimeModule {
  AuthStorage?: {
    inMemory(data?: Record<string, unknown>): PiAuthStorage;
  };
  ModelRegistry?: {
    inMemory(storage: PiAuthStorage): PiModelRegistry;
  };
  ModelRuntime?: {
    create(options?: {
      credentials?: PiCredentialStore;
    }): Promise<PiModelRuntime>;
  };
}

export interface PiCredential {
  type: "api_key" | "oauth";
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
}

export interface PiCredentialStore {
  read(provider: string): Promise<PiCredential | undefined>;
  list(): Promise<Array<{ providerId: string; type: "api_key" | "oauth" }>>;
  modify(
    provider: string,
    update: (
      current: PiCredential | undefined,
    ) => Promise<PiCredential | undefined>,
  ): Promise<PiCredential | undefined>;
  delete(provider: string): Promise<void>;
}

export type PiAuthPrompt =
  | {
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
      signal?: AbortSignal;
    }
  | {
      type: "select";
      message: string;
      options: ReadonlyArray<{ id: string; label: string }>;
      signal?: AbortSignal;
    };

export type PiAuthEvent =
  | { type: "info" | "progress"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; verificationUri: string; userCode: string };

export interface PiModelRuntime {
  login(
    provider: string,
    type: "oauth",
    interaction: {
      signal?: AbortSignal;
      prompt(prompt: PiAuthPrompt): Promise<string>;
      notify(event: PiAuthEvent): void;
    },
  ): Promise<PiCredential>;
  getAuth(
    provider: string,
    options?: { minOAuthValidityMs?: number },
  ): Promise<
    { auth: { apiKey?: string; headers?: Record<string, string> } } | undefined
  >;
}

export interface PiAuthStorage {
  login(
    provider: string,
    callbacks: {
      onAuth(info: { instructions?: string; url: string }): void;
      onDeviceCode(info: { verificationUri: string; userCode: string }): void;
      onPrompt(prompt: {
        message: string;
        placeholder?: string;
      }): Promise<string>;
      onManualCodeInput(): Promise<string>;
      onProgress(message: string): void;
      onSelect(prompt: {
        options: Array<{ id: string; label: string }>;
      }): Promise<string | undefined>;
    },
  ): Promise<void>;
  get(provider: string): unknown;
  getApiKey(
    provider: string,
    options?: { includeFallback?: boolean },
  ): Promise<string | undefined>;
}

export interface PiModelRegistry {
  getAll(): Array<{ provider: string; id: string }>;
}

export async function loadPiRuntimeModule(
  resolution: PiRuntimeResolution,
): Promise<PiRuntimeModule> {
  const entry = pathToFileURL(join(resolution.packageRoot, "dist", "index.js"));
  const loaded = (await import(entry.href)) as Partial<PiRuntimeModule>;
  if (!loaded.ModelRuntime?.create && !loaded.AuthStorage?.inMemory)
    throw new RrError(
      `Pi ${resolution.version} is incompatible with rr's runtime interface`,
    );
  return loaded;
}
