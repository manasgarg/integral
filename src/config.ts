import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { atomicWrite, readText } from "./fs.ts";
import {
  DEFAULT_PI_IMAGE,
  DEFAULT_PORTS,
  type Component,
} from "./constants.ts";
import { IntegralError } from "./errors.ts";
import type { IntegralPaths } from "./paths.ts";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
export type LogFormat = "text" | "json";
export type PullPolicy = "always" | "if-not-present" | "never";
export type ValueSource = "built-in" | "file" | "environment";

export interface EffectiveConfig {
  server: Record<`${Component}Port`, number>;
  runner: {
    image: string;
    pullPolicy: PullPolicy;
    turnTimeoutSeconds: number;
    idleTimeoutSeconds: number;
    memoryMb: number;
    tmpfsMb: number;
  };
  conversation: { contextMaxMessages: number; contextMaxChars: number };
  repositories: {
    maxFileBytes: number;
    maxRepoBytes: number;
    recoveryRetentionDays: number;
  };
  stores: { snapshots: number };
  logging: { level: LogLevel; format: LogFormat };
  sources: Record<string, ValueSource>;
  fingerprint: string;
}

const defaults = {
  "server.gateway_port": DEFAULT_PORTS.gateway,
  "server.coordinator_port": DEFAULT_PORTS.coordinator,
  "server.runner_port": DEFAULT_PORTS.runner,
  "server.scheduler_port": DEFAULT_PORTS.scheduler,
  "runner.image": DEFAULT_PI_IMAGE,
  "runner.pull_policy": "if-not-present",
  "runner.turn_timeout_seconds": 1800,
  "runner.idle_timeout_seconds": 300,
  "runner.memory_mb": 2048,
  "runner.tmpfs_mb": 2048,
  "conversation.context_max_messages": 200,
  "conversation.context_max_chars": 100000,
  "repositories.max_file_bytes": 100000000,
  "repositories.max_repo_bytes": 1000000000,
  "repositories.recovery_retention_days": 14,
  "stores.snapshots": 14,
  "logging.level": "info",
  "logging.format": "text",
} as const;

const allowed: Record<string, readonly string[]> = {
  server: ["gateway_port", "coordinator_port", "runner_port", "scheduler_port"],
  runner: [
    "image",
    "pull_policy",
    "turn_timeout_seconds",
    "idle_timeout_seconds",
    "memory_mb",
    "tmpfs_mb",
  ],
  conversation: ["context_max_messages", "context_max_chars"],
  repositories: ["max_file_bytes", "max_repo_bytes", "recovery_retention_days"],
  stores: ["snapshots"],
  logging: ["level", "format"],
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function int(value: unknown, key: string, positive = true): number {
  if (
    !Number.isInteger(value) ||
    (positive ? Number(value) <= 0 : Number(value) < 0)
  ) {
    throw new IntegralError(
      `${key} must be a ${positive ? "positive" : "non-negative"} integer`,
    );
  }
  return Number(value);
}

function port(value: unknown, key: string): number {
  const result = int(value, key);
  if (result > 65535)
    throw new IntegralError(`${key} must be between 1 and 65535`);
  return result;
}

function stringChoice<T extends string>(
  value: unknown,
  key: string,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new IntegralError(`${key} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

function stringValue(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new IntegralError(`${key} must be a non-empty string`);
  return value;
}

export function validateMain(
  raw: unknown,
  file = "integral.toml",
): Record<string, unknown> {
  const root = object(raw);
  const errors: string[] = [];
  for (const [section, value] of Object.entries(root)) {
    if (!allowed[section]) {
      errors.push(`${file}: unknown section [${section}]`);
      continue;
    }
    if (object(value) !== value) {
      errors.push(`${file}: [${section}] must be a table`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!allowed[section].includes(key))
        errors.push(`${file}: unknown option ${section}.${key}`);
      if (/credential|secret|token|api[_-]?key|password/i.test(key))
        errors.push(
          `${file}: ${section}.${key}: credentials must be stored through integral connection add`,
        );
    }
  }
  if (errors.length) throw new IntegralError(errors.join("\n"));
  return root;
}

function parseEnvPort(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw))
    throw new IntegralError(
      `${name} must be a decimal port from 1 through 65535`,
    );
  return port(Number(raw), name);
}

export async function loadConfig(
  paths: IntegralPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EffectiveConfig> {
  const text = await readText(paths.mainConfig);
  let root: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      root = validateMain(parse(text), paths.mainConfig);
    } catch (error) {
      if (error instanceof IntegralError) throw error;
      throw new IntegralError(`${paths.mainConfig}: ${String(error)}`);
    }
  }
  const source = (section: string, key: string): ValueSource =>
    object(root[section])[key] === undefined ? "built-in" : "file";
  const val = (section: string, key: string): unknown =>
    object(root[section])[key] ??
    defaults[`${section}.${key}` as keyof typeof defaults];
  const envPortErrors: string[] = [],
    envPorts: Record<Component, number | undefined> = {
      gateway: undefined,
      coordinator: undefined,
      runner: undefined,
      scheduler: undefined,
    };
  for (const component of [
    "gateway",
    "coordinator",
    "runner",
    "scheduler",
  ] as const) {
    const name = `INTEGRAL_${component.toUpperCase()}_PORT`;
    try {
      envPorts[component] = parseEnvPort(env, name);
    } catch (error) {
      envPortErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (envPortErrors.length) throw new IntegralError(envPortErrors.join("\n"));
  const server = {
    gatewayPort:
      envPorts.gateway ??
      port(val("server", "gateway_port"), "server.gateway_port"),
    coordinatorPort:
      envPorts.coordinator ??
      port(val("server", "coordinator_port"), "server.coordinator_port"),
    runnerPort:
      envPorts.runner ??
      port(val("server", "runner_port"), "server.runner_port"),
    schedulerPort:
      envPorts.scheduler ??
      port(val("server", "scheduler_port"), "server.scheduler_port"),
  };
  if (new Set(Object.values(server)).size !== 4) {
    const conflicts = Object.entries(server)
      .filter(([, value], index, all) =>
        all.some(
          ([, other], otherIndex) => otherIndex !== index && other === value,
        ),
      )
      .map(([name, value]) => `${name}=${value}`);
    throw new IntegralError(
      `gateway, coordinator, runner, and scheduler ports must be distinct; conflicts: ${conflicts.join(", ")}`,
    );
  }
  const fileLogging = object(root.logging);
  const logLevelRaw =
    env.INTEGRAL_LOG_LEVEL?.trim() ||
    fileLogging.level ||
    defaults["logging.level"];
  const logFormatRaw =
    env.INTEGRAL_LOG_FORMAT?.trim() ||
    fileLogging.format ||
    defaults["logging.format"];
  const logging = {
    level: stringChoice(
      logLevelRaw,
      env.INTEGRAL_LOG_LEVEL?.trim() ? "INTEGRAL_LOG_LEVEL" : "logging.level",
      ["error", "warn", "info", "debug", "trace"],
    ),
    format: stringChoice(
      logFormatRaw,
      env.INTEGRAL_LOG_FORMAT?.trim()
        ? "INTEGRAL_LOG_FORMAT"
        : "logging.format",
      ["text", "json"],
    ),
  };
  const runner = {
    image: stringValue(val("runner", "image"), "runner.image"),
    pullPolicy: stringChoice(
      val("runner", "pull_policy"),
      "runner.pull_policy",
      ["always", "if-not-present", "never"],
    ),
    turnTimeoutSeconds: int(
      val("runner", "turn_timeout_seconds"),
      "runner.turn_timeout_seconds",
    ),
    idleTimeoutSeconds: int(
      val("runner", "idle_timeout_seconds"),
      "runner.idle_timeout_seconds",
    ),
    memoryMb: int(val("runner", "memory_mb"), "runner.memory_mb"),
    tmpfsMb: int(val("runner", "tmpfs_mb"), "runner.tmpfs_mb"),
  };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(runner.image))
    throw new IntegralError("runner.image must be a valid OCI image reference");
  const conversation = {
    contextMaxMessages: int(
      val("conversation", "context_max_messages"),
      "conversation.context_max_messages",
      false,
    ),
    contextMaxChars: int(
      val("conversation", "context_max_chars"),
      "conversation.context_max_chars",
      false,
    ),
  };
  const repositories = {
    maxFileBytes: int(
      val("repositories", "max_file_bytes"),
      "repositories.max_file_bytes",
    ),
    maxRepoBytes: int(
      val("repositories", "max_repo_bytes"),
      "repositories.max_repo_bytes",
    ),
    recoveryRetentionDays: int(
      val("repositories", "recovery_retention_days"),
      "repositories.recovery_retention_days",
    ),
  };
  if (repositories.maxRepoBytes < repositories.maxFileBytes)
    throw new IntegralError(
      "repositories.max_repo_bytes must not be smaller than repositories.max_file_bytes",
    );
  const stores = {
    snapshots: int(val("stores", "snapshots"), "stores.snapshots", false),
  };
  const sources: Record<string, ValueSource> = {};
  for (const key of Object.keys(defaults)) {
    const [section, option] = key.split(".") as [string, string];
    sources[key] = source(section, option);
  }
  for (const [component, envValue] of Object.entries(envPorts))
    if (envValue !== undefined)
      sources[`server.${component}_port`] = "environment";
  if (env.INTEGRAL_LOG_LEVEL?.trim()) sources["logging.level"] = "environment";
  if (env.INTEGRAL_LOG_FORMAT?.trim())
    sources["logging.format"] = "environment";
  const shared = {
    server,
    runner,
    conversation,
    repositories,
    stores,
    logging,
  };
  const fingerprinted = {
    ...shared,
    server: {
      gatewayPort: port(val("server", "gateway_port"), "server.gateway_port"),
      coordinatorPort: port(
        val("server", "coordinator_port"),
        "server.coordinator_port",
      ),
      runnerPort: port(val("server", "runner_port"), "server.runner_port"),
      schedulerPort: port(
        val("server", "scheduler_port"),
        "server.scheduler_port",
      ),
    },
  };
  return {
    ...shared,
    sources,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprinted))
      .digest("hex"),
  };
}

export const STARTER_CONFIG = `# integral Phase 1 configuration\n\n[server]\ngateway_port = 7310\ncoordinator_port = 7311\nrunner_port = 7312\nscheduler_port = 7313\n\n[runner]\nimage = "${DEFAULT_PI_IMAGE}"\npull_policy = "if-not-present"\nturn_timeout_seconds = 1800\nidle_timeout_seconds = 300\nmemory_mb = 2048\ntmpfs_mb = 2048\n\n[conversation]\ncontext_max_messages = 200\ncontext_max_chars = 100000\n\n[repositories]\nmax_file_bytes = 100000000\nmax_repo_bytes = 1000000000\nrecovery_retention_days = 14\n\n[stores]\nsnapshots = 14\n\n[logging]\nlevel = "info"\nformat = "text"\n`;

export async function initConfig(paths: IntegralPaths): Promise<void> {
  if ((await readText(paths.mainConfig)) !== undefined)
    throw new IntegralError(
      `${paths.mainConfig} already exists; refusing to overwrite it`,
    );
  validateMain(parse(STARTER_CONFIG), paths.mainConfig);
  await atomicWrite(paths.mainConfig, STARTER_CONFIG);
}
