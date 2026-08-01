import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "smol-toml";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import { RrError } from "./errors.ts";
import type { RrPaths } from "./paths.ts";

export type ConnectionKind = "model" | "http" | "mcp";
export type AuthMethod = "oauth" | "device-code" | "key" | "none";
export interface Connection {
  name: string;
  kind: ConnectionKind;
  provider?: string;
  url?: string;
  auth: AuthMethod;
  methods?: string[];
  pathPrefix?: string;
  header?: string;
  scheme?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  deviceAuthorizationUrl?: string;
  clientId?: string;
  scopes?: string[];
  transport?: "streamable-http" | "sse";
}
export interface ListedConnection extends Connection {
  state: "active" | "DISABLED (no secret)";
}

export const CATALOG = [
  {
    name: "openai-codex",
    kind: "model",
    auth: ["oauth", "device-code"],
    defaultAuth: "oauth",
  },
  {
    name: "anthropic",
    kind: "model",
    auth: ["oauth", "key"],
    defaultAuth: "oauth",
  },
  { name: "http", kind: "http", auth: ["oauth", "device-code", "key", "none"] },
  { name: "mcp", kind: "mcp", auth: ["oauth", "device-code", "key", "none"] },
] as const;

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const knownKeys = new Set([
  "name",
  "kind",
  "provider",
  "url",
  "auth",
  "methods",
  "path_prefix",
  "header",
  "scheme",
  "authorization_url",
  "token_url",
  "device_authorization_url",
  "client_id",
  "scopes",
  "transport",
]);

function table(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new RrError("connection declaration must be a TOML table");
  return raw as Record<string, unknown>;
}
function requiredString(raw: unknown, key: string): string {
  if (typeof raw !== "string" || !raw.trim())
    throw new RrError(`${key} is required`);
  return raw;
}
function optionalStrings(raw: unknown, key: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !v))
    throw new RrError(`${key} must be a list of strings`);
  return raw as string[];
}
function secureUrl(raw: unknown, key: string): string {
  const value = requiredString(raw, key);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RrError(`${key} must be a valid HTTP or HTTPS URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new RrError(`${key} must use HTTP or HTTPS`);
  return parsed.toString();
}
function oauthUrl(raw: unknown, key: string): string {
  const value = secureUrl(raw, key);
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  )
    throw new RrError(`${key} must use HTTPS unless it targets loopback`);
  return value;
}

export function validateConnection(raw: unknown, stem?: string): Connection {
  const value = table(raw);
  for (const key of Object.keys(value)) {
    if (
      /^(credential|secret|password|api[_-]?key|access_token|refresh_token|oauth_code)$/i.test(
        key,
      )
    )
      throw new RrError(
        `${key}: credentials must be stored through rr connection add`,
      );
    if (!knownKeys.has(key))
      throw new RrError(`unknown connection option: ${key}`);
  }
  const name = requiredString(value.name, "name");
  if (!namePattern.test(name))
    throw new RrError(
      "name must be filesystem-safe (letters, numbers, dot, underscore, or hyphen)",
    );
  if (stem && stem !== name)
    throw new RrError(
      `connection file stem ${stem} does not match declared name ${name}`,
    );
  const kind = requiredString(value.kind, "kind") as ConnectionKind;
  if (!["model", "http", "mcp"].includes(kind))
    throw new RrError("kind must be model, http, or mcp");
  const provider =
    value.provider === undefined
      ? undefined
      : requiredString(value.provider, "provider");
  if (
    kind === "model" &&
    !CATALOG.some((e) => e.kind === "model" && e.name === provider)
  )
    throw new RrError("provider must name a catalog model provider");
  const catalog = CATALOG.find((e) => e.name === provider);
  const auth = (value.auth ??
    (catalog && "defaultAuth" in catalog ? catalog.defaultAuth : undefined)) as
    AuthMethod | undefined;
  if (!auth || !["oauth", "device-code", "key", "none"].includes(auth))
    throw new RrError("auth must be oauth, device-code, key, or none");
  if (kind === "model" && auth === "none")
    throw new RrError("model connections do not support no authentication");
  const url = kind === "model" ? undefined : secureUrl(value.url, "url");
  const methods =
    optionalStrings(value.methods, "methods")?.map((m) => m.toUpperCase()) ??
    (kind === "http" ? ["*"] : undefined);
  if (methods && methods.length === 0)
    throw new RrError("methods must not be empty");
  if (methods?.some((m) => m !== "*" && !/^[A-Z]+$/.test(m)))
    throw new RrError("methods must contain HTTP methods or *");
  const pathPrefix =
    value.path_prefix === undefined
      ? undefined
      : requiredString(value.path_prefix, "path_prefix");
  if (url && pathPrefix) {
    if (!pathPrefix.startsWith("/"))
      throw new RrError("path_prefix must start with /");
    const basePath = new URL(url).pathname;
    if (!pathPrefix.startsWith(basePath))
      throw new RrError("path_prefix may only narrow the connection URL path");
  }
  const result: Connection = { name, kind, auth };
  if (provider) result.provider = provider;
  if (url) result.url = url;
  if (methods) result.methods = methods;
  if (pathPrefix) result.pathPrefix = pathPrefix;
  if (auth === "key") {
    result.header =
      value.header === undefined
        ? "Authorization"
        : requiredString(value.header, "header");
    result.scheme =
      value.scheme === undefined
        ? "Bearer"
        : requiredString(value.scheme, "scheme");
    if (/\r|\n/.test(result.header + result.scheme))
      throw new RrError(
        "header and scheme must not contain control characters",
      );
  }
  if (auth === "oauth" || auth === "device-code") {
    if (kind !== "model") {
      result.authorizationUrl = oauthUrl(
        value.authorization_url,
        "authorization_url",
      );
      result.tokenUrl = oauthUrl(value.token_url, "token_url");
      result.clientId = requiredString(value.client_id, "client_id");
      if (auth === "device-code")
        result.deviceAuthorizationUrl = oauthUrl(
          value.device_authorization_url,
          "device_authorization_url",
        );
      const scopes = optionalStrings(value.scopes, "scopes");
      if (scopes) result.scopes = scopes;
    }
  }
  if (kind === "mcp") {
    const transport = value.transport ?? "streamable-http";
    if (transport !== "streamable-http" && transport !== "sse")
      throw new RrError("transport must be streamable-http or sse");
    result.transport = transport;
  }
  return result;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
export function connectionToml(c: Connection): string {
  const rows = [`name = ${quote(c.name)}`, `kind = ${quote(c.kind)}`];
  const scalar: [string, string | undefined][] = [
    ["provider", c.provider],
    ["url", c.url],
    ["auth", c.auth],
    ["path_prefix", c.pathPrefix],
    ["header", c.header],
    ["scheme", c.scheme],
    ["authorization_url", c.authorizationUrl],
    ["token_url", c.tokenUrl],
    ["device_authorization_url", c.deviceAuthorizationUrl],
    ["client_id", c.clientId],
    ["transport", c.transport],
  ];
  for (const [key, value] of scalar)
    if (value !== undefined && !rows.some((row) => row.startsWith(`${key} =`)))
      rows.push(`${key} = ${quote(value)}`);
  if (c.methods) rows.push(`methods = [${c.methods.map(quote).join(", ")}]`);
  if (c.scopes) rows.push(`scopes = [${c.scopes.map(quote).join(", ")}]`);
  return `${rows.join("\n")}\n`;
}

export async function loadConnections(
  paths: RrPaths,
): Promise<{ connections: Connection[]; errors: string[] }> {
  let files: string[];
  try {
    files = (await readdir(paths.connections))
      .filter((f) => f.endsWith(".toml"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { connections: [], errors: [] };
    throw error;
  }
  const connections: Connection[] = [],
    errors: string[] = [],
    names = new Set<string>();
  for (const file of files) {
    try {
      const c = validateConnection(
        parse(await readFile(join(paths.connections, file), "utf8")),
        basename(file, ".toml"),
      );
      if (names.has(c.name))
        throw new RrError(`duplicate connection name: ${c.name}`);
      names.add(c.name);
      connections.push(c);
    } catch (error) {
      errors.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { connections, errors };
}

export async function credentialFor(
  paths: RrPaths,
  name: string,
): Promise<string | undefined> {
  return readText(join(paths.credentials, name));
}
export async function credentialSecretValues(
  paths: RrPaths,
): Promise<string[]> {
  const loaded = await loadConnections(paths),
    values = new Set<string>();
  for (const connection of loaded.connections) {
    const raw = await credentialFor(paths, connection.name);
    if (!raw) continue;
    values.add(raw.trim());
    try {
      collectStrings(JSON.parse(raw), values);
    } catch {
      /* opaque key */
    }
  }
  return [...values].filter(Boolean);
}
function collectStrings(value: unknown, values: Set<string>): void {
  if (typeof value === "string") {
    if (value) values.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, values);
    return;
  }
  if (value && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, values);
}
export async function listConnections(
  paths: RrPaths,
): Promise<ListedConnection[]> {
  const loaded = await loadConnections(paths);
  if (loaded.errors.length) throw new RrError(loaded.errors.join("\n"));
  return Promise.all(
    loaded.connections.map(async (c) => ({
      ...c,
      state:
        c.auth === "none" ||
        usableCredential(c, await credentialFor(paths, c.name))
          ? "active"
          : "DISABLED (no secret)",
    })),
  );
}
function usableCredential(
  connection: Connection,
  raw: string | undefined,
): boolean {
  if (!raw?.trim()) return false;
  if (connection.auth === "key") return true;
  try {
    const value = JSON.parse(raw) as {
      type?: string;
      access?: string;
      refresh?: string;
      expires?: number;
    };
    return (
      value.type === "oauth" &&
      Boolean(value.access) &&
      (Number(value.expires) > Date.now() || Boolean(value.refresh))
    );
  } catch {
    return false;
  }
}

async function bumpGeneration(paths: RrPaths): Promise<number> {
  const file = join(paths.state, "connection-generation");
  const current = Number((await readText(file))?.trim() || "0");
  const next = Number.isSafeInteger(current) ? current + 1 : 1;
  await atomicWrite(file, `${next}\n`);
  return next;
}

export async function saveConnection(
  paths: RrPaths,
  connection: Connection,
  credential?: string,
): Promise<{ rotated: boolean; generation: number }> {
  const declaration = join(paths.connections, `${connection.name}.toml`);
  const existed = await readText(declaration);
  const validated = validateConnection(connection);
  if (connection.auth !== "none" && !credential)
    throw new RrError(
      `authentication credential is required for ${connection.auth}`,
    );
  if (existed === undefined) {
    const all = await loadConnections(paths);
    if (all.connections.some((c) => c.name === connection.name))
      throw new RrError(`connection ${connection.name} already exists`);
    if (credential)
      await atomicWrite(join(paths.credentials, connection.name), credential);
    try {
      await atomicWrite(declaration, connectionToml(validated));
    } catch (error) {
      if (credential)
        await rm(join(paths.credentials, connection.name), { force: true });
      throw error;
    }
  } else {
    const current = validateConnection(parse(existed), connection.name);
    if (
      current.auth === "none" ||
      current.kind !== connection.kind ||
      current.provider !== connection.provider ||
      current.auth !== connection.auth
    )
      throw new RrError(`connection name already used: ${connection.name}`);
    // Rotation intentionally changes only the protected credential file.
    await atomicWrite(join(paths.credentials, connection.name), credential!);
  }
  return {
    rotated: existed !== undefined,
    generation: await bumpGeneration(paths),
  };
}

export async function removeCredential(
  paths: RrPaths,
  name: string,
): Promise<void> {
  await rm(join(paths.credentials, name), { force: true });
  await bumpGeneration(paths);
}
export async function removeConnection(
  paths: RrPaths,
  name: string,
): Promise<void> {
  const file = join(paths.connections, `${name}.toml`);
  try {
    await stat(file);
  } catch {
    throw new RrError(`connection not found: ${name}`);
  }
  await rm(file);
  await rm(join(paths.credentials, name), { force: true });
  await bumpGeneration(paths);
}

export async function prepareStorage(paths: RrPaths): Promise<void> {
  await ensureDir(paths.connections);
  await ensureDir(paths.credentials);
}
