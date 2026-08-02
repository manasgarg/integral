import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "smol-toml";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import { IntegralError } from "./errors.ts";
import type { IntegralPaths } from "./paths.ts";

export type ConnectionKind = "model" | "http" | "mcp" | "email";
export type AuthMethod = "oauth" | "device-code" | "key" | "none";
export type EmailCapability = "read" | "search" | "send";
export interface Connection {
  name: string;
  kind: ConnectionKind;
  provider?: string;
  url?: string;
  hosts?: string[];
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
  capabilities?: EmailCapability[];
  account?: string;
  domain?: string;
  fromAddress?: string;
  region?: "us" | "eu";
  allowedRecipients?: string[];
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
    name: "github",
    kind: "http",
    auth: ["key"],
    defaultAuth: "key",
    hosts: ["api.github.com", "github.com"],
  },
  {
    name: "anthropic",
    kind: "model",
    auth: ["oauth", "key"],
    defaultAuth: "oauth",
  },
  { name: "http", kind: "http", auth: ["oauth", "device-code", "key", "none"] },
  { name: "mcp", kind: "mcp", auth: ["oauth", "device-code", "key", "none"] },
  { name: "gmail", kind: "email", auth: ["oauth"] },
  { name: "mailgun", kind: "email", auth: ["key"] },
] as const;

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const knownKeys = new Set([
  "name",
  "kind",
  "provider",
  "url",
  "hosts",
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
  "capabilities",
  "account",
  "domain",
  "from_address",
  "region",
  "allowed_recipients",
]);

const emailAddressPattern = /^[^\s<>@,;]+@[^\s<>@,;]+$/;
const domainPattern =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function table(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new IntegralError("connection declaration must be a TOML table");
  return raw as Record<string, unknown>;
}
function requiredString(raw: unknown, key: string): string {
  if (typeof raw !== "string" || !raw.trim())
    throw new IntegralError(`${key} is required`);
  return raw;
}
function optionalStrings(raw: unknown, key: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !v))
    throw new IntegralError(`${key} must be a list of strings`);
  return raw as string[];
}
function secureUrl(raw: unknown, key: string): string {
  const value = requiredString(raw, key);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new IntegralError(`${key} must be a valid HTTP or HTTPS URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new IntegralError(`${key} must use HTTP or HTTPS`);
  return parsed.toString();
}
function oauthUrl(raw: unknown, key: string): string {
  const value = secureUrl(raw, key);
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  )
    throw new IntegralError(`${key} must use HTTPS unless it targets loopback`);
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
      throw new IntegralError(
        `${key}: credentials must be stored through integral connection add`,
      );
    if (!knownKeys.has(key))
      throw new IntegralError(`unknown connection option: ${key}`);
  }
  const name = requiredString(value.name, "name");
  if (!namePattern.test(name))
    throw new IntegralError(
      "name must be filesystem-safe (letters, numbers, dot, underscore, or hyphen)",
    );
  if (stem && stem !== name)
    throw new IntegralError(
      `connection file stem ${stem} does not match declared name ${name}`,
    );
  const kind = requiredString(value.kind, "kind") as ConnectionKind;
  if (!["model", "http", "mcp", "email"].includes(kind))
    throw new IntegralError("kind must be model, http, mcp, or email");
  const provider =
    value.provider === undefined
      ? undefined
      : requiredString(value.provider, "provider");
  if (
    kind === "model" &&
    !CATALOG.some((e) => e.kind === "model" && e.name === provider)
  )
    throw new IntegralError("provider must name a catalog model provider");
  if (
    kind === "email" &&
    !CATALOG.some((e) => e.kind === "email" && e.name === provider)
  )
    throw new IntegralError("provider must be gmail or mailgun");
  if (provider === "github" && kind !== "http")
    throw new IntegralError("GitHub connections must use kind http");
  const catalog = CATALOG.find((e) => e.name === provider);
  const auth = (value.auth ??
    (catalog && "defaultAuth" in catalog ? catalog.defaultAuth : undefined)) as
    AuthMethod | undefined;
  if (!auth || !["oauth", "device-code", "key", "none"].includes(auth))
    throw new IntegralError("auth must be oauth, device-code, key, or none");
  if (kind === "model" && auth === "none")
    throw new IntegralError(
      "model connections do not support no authentication",
    );
  if (provider === "github" && auth !== "key")
    throw new IntegralError("GitHub connections require key authentication");
  const url =
    (kind === "http" || kind === "mcp") && provider !== "github"
      ? secureUrl(value.url, "url")
      : undefined;
  const hosts = optionalStrings(value.hosts, "hosts")?.map((host) =>
    host.toLowerCase(),
  );
  if (provider === "github") {
    if (
      !hosts?.length ||
      new Set(hosts).size !== hosts.length ||
      hosts.some((host) => host !== "api.github.com" && host !== "github.com")
    )
      throw new IntegralError(
        "GitHub hosts must be a non-empty unique subset of api.github.com and github.com",
      );
    if (value.url !== undefined)
      throw new IntegralError("GitHub connections use hosts instead of url");
  } else if (value.hosts !== undefined) {
    throw new IntegralError("hosts is supported only by the GitHub preset");
  }
  const methods =
    optionalStrings(value.methods, "methods")?.map((m) => m.toUpperCase()) ??
    (kind === "http" ? ["*"] : undefined);
  if (methods && methods.length === 0)
    throw new IntegralError("methods must not be empty");
  if (methods?.some((m) => m !== "*" && !/^[A-Z]+$/.test(m)))
    throw new IntegralError("methods must contain HTTP methods or *");
  const pathPrefix =
    value.path_prefix === undefined
      ? undefined
      : requiredString(value.path_prefix, "path_prefix");
  if (url && pathPrefix) {
    if (!pathPrefix.startsWith("/"))
      throw new IntegralError("path_prefix must start with /");
    const basePath = new URL(url).pathname;
    if (!pathPrefix.startsWith(basePath))
      throw new IntegralError(
        "path_prefix may only narrow the connection URL path",
      );
  }
  const result: Connection = { name, kind, auth };
  if (provider) result.provider = provider;
  if (url) result.url = url;
  if (hosts) result.hosts = hosts;
  if (methods) result.methods = methods;
  if (pathPrefix) result.pathPrefix = pathPrefix;
  if (auth === "key" && kind !== "email") {
    result.header =
      value.header === undefined
        ? "Authorization"
        : requiredString(value.header, "header");
    result.scheme =
      value.scheme === undefined
        ? "Bearer"
        : requiredString(value.scheme, "scheme");
    if (/\r|\n/.test(result.header + result.scheme))
      throw new IntegralError(
        "header and scheme must not contain control characters",
      );
  }
  if (auth === "oauth" || auth === "device-code") {
    if (kind === "http" || kind === "mcp") {
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
      throw new IntegralError("transport must be streamable-http or sse");
    result.transport = transport;
  }
  if (kind === "email") {
    const supported: readonly EmailCapability[] =
      provider === "gmail" ? ["read", "search", "send"] : ["send"];
    const capabilities = optionalStrings(value.capabilities, "capabilities") as
      EmailCapability[] | undefined;
    if (!capabilities?.length)
      throw new IntegralError("email capabilities must not be empty");
    if (
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => !supported.includes(capability))
    )
      throw new IntegralError(
        `${provider} capabilities must contain unique values from: ${supported.join(", ")}`,
      );
    result.capabilities = capabilities;
    if (capabilities.includes("send")) {
      const allowed = optionalStrings(
        value.allowed_recipients,
        "allowed_recipients",
      );
      if (!allowed?.length)
        throw new IntegralError("send capability requires allowed_recipients");
      if (
        allowed.some(
          (recipient) =>
            !emailAddressPattern.test(recipient) &&
            !(
              recipient.startsWith("*@") &&
              domainPattern.test(recipient.slice(2))
            ),
        )
      )
        throw new IntegralError(
          "allowed_recipients must contain email addresses or *@domain wildcards",
        );
      result.allowedRecipients = allowed.map((recipient) =>
        recipient.toLowerCase(),
      );
    }
    if (provider === "gmail") {
      if (auth !== "oauth")
        throw new IntegralError("gmail requires oauth authentication");
      const account = requiredString(value.account, "account");
      if (!emailAddressPattern.test(account))
        throw new IntegralError("account must be an email address");
      result.account = account;
      result.authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth";
      result.tokenUrl = "https://oauth2.googleapis.com/token";
      result.clientId = requiredString(value.client_id, "client_id");
      result.scopes = [
        ...(capabilities.some((capability) => capability !== "send")
          ? ["https://www.googleapis.com/auth/gmail.readonly"]
          : []),
        ...(capabilities.includes("send")
          ? ["https://www.googleapis.com/auth/gmail.send"]
          : []),
      ];
    } else {
      if (auth !== "key")
        throw new IntegralError("mailgun requires key authentication");
      const domain = requiredString(value.domain, "domain").toLowerCase();
      if (!domainPattern.test(domain))
        throw new IntegralError("domain must be a valid DNS domain");
      const fromAddress = requiredString(value.from_address, "from_address");
      if (
        !emailAddressPattern.test(fromAddress) ||
        fromAddress.toLowerCase().split("@")[1] !== domain
      )
        throw new IntegralError(
          "from_address must be an email address in the Mailgun domain",
        );
      const region = value.region ?? "us";
      if (region !== "us" && region !== "eu")
        throw new IntegralError("region must be us or eu");
      result.domain = domain;
      result.fromAddress = fromAddress;
      result.region = region;
    }
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
    ["account", c.account],
    ["domain", c.domain],
    ["from_address", c.fromAddress],
    ["region", c.region],
  ];
  for (const [key, value] of scalar)
    if (value !== undefined && !rows.some((row) => row.startsWith(`${key} =`)))
      rows.push(`${key} = ${quote(value)}`);
  if (c.methods) rows.push(`methods = [${c.methods.map(quote).join(", ")}]`);
  if (c.hosts) rows.push(`hosts = [${c.hosts.map(quote).join(", ")}]`);
  if (c.scopes) rows.push(`scopes = [${c.scopes.map(quote).join(", ")}]`);
  if (c.capabilities)
    rows.push(`capabilities = [${c.capabilities.map(quote).join(", ")}]`);
  if (c.allowedRecipients)
    rows.push(
      `allowed_recipients = [${c.allowedRecipients.map(quote).join(", ")}]`,
    );
  return `${rows.join("\n")}\n`;
}

export function connectionBoundaries(connection: Connection): URL[] {
  if (connection.provider === "github")
    return (connection.hosts ?? []).map((host) => new URL(`https://${host}/`));
  return connection.url ? [new URL(connection.url)] : [];
}

export async function loadConnections(
  paths: IntegralPaths,
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
        throw new IntegralError(`duplicate connection name: ${c.name}`);
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
  paths: IntegralPaths,
  name: string,
): Promise<string | undefined> {
  return readText(join(paths.credentials, name));
}
export async function credentialSecretValues(
  paths: IntegralPaths,
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
  paths: IntegralPaths,
): Promise<ListedConnection[]> {
  const loaded = await loadConnections(paths);
  if (loaded.errors.length) throw new IntegralError(loaded.errors.join("\n"));
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

async function bumpGeneration(paths: IntegralPaths): Promise<number> {
  const file = join(paths.state, "connection-generation");
  const current = Number((await readText(file))?.trim() || "0");
  const next = Number.isSafeInteger(current) ? current + 1 : 1;
  await atomicWrite(file, `${next}\n`);
  return next;
}

export async function saveConnection(
  paths: IntegralPaths,
  connection: Connection,
  credential?: string,
): Promise<{ rotated: boolean; generation: number }> {
  const declaration = join(paths.connections, `${connection.name}.toml`);
  const existed = await readText(declaration);
  const validated = validateConnection(parse(connectionToml(connection)));
  if (connection.auth !== "none" && !credential)
    throw new IntegralError(
      `authentication credential is required for ${connection.auth}`,
    );
  if (existed === undefined) {
    const all = await loadConnections(paths);
    if (all.connections.some((c) => c.name === connection.name))
      throw new IntegralError(`connection ${connection.name} already exists`);
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
      throw new IntegralError(
        `connection name already used: ${connection.name}`,
      );
    // Rotation intentionally changes only the protected credential file.
    await atomicWrite(join(paths.credentials, connection.name), credential!);
  }
  return {
    rotated: existed !== undefined,
    generation: await bumpGeneration(paths),
  };
}

export async function removeCredential(
  paths: IntegralPaths,
  name: string,
): Promise<void> {
  await rm(join(paths.credentials, name), { force: true });
  await bumpGeneration(paths);
}
export async function removeConnection(
  paths: IntegralPaths,
  name: string,
): Promise<void> {
  const file = join(paths.connections, `${name}.toml`);
  try {
    await stat(file);
  } catch {
    throw new IntegralError(`connection not found: ${name}`);
  }
  await rm(file);
  await rm(join(paths.credentials, name), { force: true });
  await bumpGeneration(paths);
}

export async function prepareStorage(paths: IntegralPaths): Promise<void> {
  await ensureDir(paths.connections);
  await ensureDir(paths.credentials);
}
