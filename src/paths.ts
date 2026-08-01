import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { IntegralError } from "./errors.ts";

export interface IntegralPaths {
  root: string;
  config: string;
  data: string;
  state: string;
  mainConfig: string;
  connections: string;
  credentials: string;
  componentState: string;
  locks: string;
  conversation: string;
  modelSelection: string;
  piRuntime: string;
  piRuntimeState: string;
  queue: string;
  ca: string;
}

function canonicalize(path: string): string {
  const normalized = normalize(resolve(path));
  try {
    return realpathSync.native(normalized);
  } catch {
    let cursor = normalized;
    const suffix: string[] = [];
    while (cursor !== dirname(cursor)) {
      try {
        return join(realpathSync.native(cursor), ...suffix.reverse());
      } catch {
        suffix.push(cursor.slice(dirname(cursor).length + 1));
        cursor = dirname(cursor);
      }
    }
    return normalized;
  }
}

export function resolveIntegralHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate =
    env.INTEGRAL_HOME?.trim() || (env.HOME ? join(env.HOME, ".integral") : "");
  if (!candidate) {
    throw new IntegralError(
      "INTEGRAL_HOME is not set and HOME is unavailable; set INTEGRAL_HOME to an absolute path",
    );
  }
  if (!isAbsolute(candidate)) {
    throw new IntegralError("INTEGRAL_HOME must be an absolute path");
  }
  return canonicalize(candidate);
}

export function pathsFor(root: string): IntegralPaths {
  const config = join(root, "config");
  const data = join(root, "data");
  const state = join(root, "state");
  return {
    root,
    config,
    data,
    state,
    mainConfig: join(config, "integral.toml"),
    connections: join(config, "connections"),
    credentials: join(data, "credentials"),
    componentState: join(state, "components"),
    locks: join(state, "locks"),
    conversation: join(data, "conversation.jsonl"),
    modelSelection: join(data, "conversation-model.json"),
    piRuntime: join(data, "pi-runtime"),
    piRuntimeState: join(state, "pi-runtime.json"),
    queue: join(data, "queue.json"),
    ca: join(data, "ca"),
  };
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
): IntegralPaths {
  return pathsFor(resolveIntegralHome(env));
}
