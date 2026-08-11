import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";
import { parse } from "smol-toml";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import { IntegralError } from "./errors.ts";
import type { IntegralPaths } from "./paths.ts";

export type ConnectionKind =
  "model" | "http" | "mcp" | "email" | "host-repo" | "host-store";
export type AuthMethod = "oauth" | "device-code" | "key" | "none";
export type EmailCapability = "read" | "search" | "send";
export type McpTransport = "streamable-http" | "sse" | "stdio";
export interface StdioCredential {
  type: "stdio-env";
  values: Record<string, string>;
}
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
  registrationUrl?: string;
  clientId?: string;
  scopes?: string[];
  oauthIssuer?: string;
  oauthResource?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  secretEnv?: string[];
  allowedUrls?: string[];
  capabilities?: EmailCapability[];
  account?: string;
  domain?: string;
  fromAddress?: string;
  region?: "us" | "eu";
  allowedRecipients?: string[];
  path?: string;
  branch?: string;
  mount?: string;
}
export interface ListedConnection extends Connection {
  state:
    | "active"
    | "degraded"
    | "unavailable"
    | "soft-deleted"
    | "DISABLED (no secret)";
  resourceId?: string;
  lifecycleRevision?: number;
  availabilityReason?: string;
  restorationPossible?: boolean;
}

export type ConnectionHealthStage =
  "authorization" | "negotiation" | "discovery" | "sidecar";

function connectionHealthFile(paths: IntegralPaths, name: string): string {
  return join(paths.state, "connection-health", `${name}.json`);
}

export async function markConnectionDegraded(
  paths: IntegralPaths,
  name: string,
  stage: ConnectionHealthStage,
): Promise<void> {
  await atomicWrite(
    connectionHealthFile(paths, name),
    `${JSON.stringify({ stage, updatedAt: new Date().toISOString() })}\n`,
  );
}

export async function clearConnectionDegraded(
  paths: IntegralPaths,
  name: string,
): Promise<void> {
  await rm(connectionHealthFile(paths, name), { force: true });
}

async function connectionHealth(
  paths: IntegralPaths,
  name: string,
): Promise<ConnectionHealthStage | undefined> {
  const raw = await readText(connectionHealthFile(paths, name));
  if (!raw) return undefined;
  const value = JSON.parse(raw) as { stage?: unknown };
  return ["authorization", "negotiation", "discovery", "sidecar"].includes(
    String(value.stage),
  )
    ? (value.stage as ConnectionHealthStage)
    : undefined;
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
  { name: "host-repo", kind: "host-repo", auth: ["none"] },
  { name: "host-store", kind: "host-store", auth: ["none"] },
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
  "registration_url",
  "client_id",
  "scopes",
  "oauth_issuer",
  "oauth_resource",
  "transport",
  "command",
  "args",
  "env",
  "secret_env",
  "allowed_urls",
  "capabilities",
  "account",
  "domain",
  "from_address",
  "region",
  "allowed_recipients",
  "path",
  "branch",
  "mount",
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
function optionalStringTable(
  raw: unknown,
  key: string,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new IntegralError(`${key} must be a table of strings`);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new IntegralError(`${key} contains an invalid environment name`);
    if (typeof value !== "string")
      throw new IntegralError(`${key} must be a table of strings`);
    result[name] = value;
  }
  return result;
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
  if (
    !["model", "http", "mcp", "email", "host-repo", "host-store"].includes(kind)
  )
    throw new IntegralError(
      "kind must be model, http, mcp, email, host-repo, or host-store",
    );
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
  const hostResource = kind === "host-repo" || kind === "host-store";
  if (hostResource && auth !== "none")
    throw new IntegralError("host resources use no authentication");
  const requestedTransport = value.transport as McpTransport | undefined;
  const stdio = kind === "mcp" && requestedTransport === "stdio";
  const url =
    (kind === "http" || (kind === "mcp" && !stdio)) && provider !== "github"
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
      const explicit =
        value.authorization_url !== undefined ||
        value.token_url !== undefined ||
        value.client_id !== undefined ||
        value.registration_url !== undefined;
      if (kind === "http" || explicit) {
        result.authorizationUrl = oauthUrl(
          value.authorization_url,
          "authorization_url",
        );
        result.tokenUrl = oauthUrl(value.token_url, "token_url");
        if (value.client_id !== undefined)
          result.clientId = requiredString(value.client_id, "client_id");
        if (value.registration_url !== undefined)
          result.registrationUrl = oauthUrl(
            value.registration_url,
            "registration_url",
          );
        if (!result.clientId && !result.registrationUrl)
          throw new IntegralError(
            "OAuth requires client_id or registration_url",
          );
      }
      if (auth === "device-code")
        result.deviceAuthorizationUrl = oauthUrl(
          value.device_authorization_url,
          "device_authorization_url",
        );
      const scopes = optionalStrings(value.scopes, "scopes");
      if (scopes) result.scopes = scopes;
      if (value.oauth_issuer !== undefined)
        result.oauthIssuer = oauthUrl(value.oauth_issuer, "oauth_issuer");
      if (value.oauth_resource !== undefined)
        result.oauthResource = secureUrl(
          value.oauth_resource,
          "oauth_resource",
        );
    }
  }
  if (kind === "mcp") {
    const transport = (value.transport ?? "streamable-http") as McpTransport;
    if (!(["streamable-http", "sse", "stdio"] as const).includes(transport))
      throw new IntegralError(
        "transport must be streamable-http, sse, or stdio",
      );
    result.transport = transport;
    if (transport === "stdio") {
      if (auth !== "none")
        throw new IntegralError(
          "stdio MCP connections use no transport authentication",
        );
      if (value.url !== undefined)
        throw new IntegralError(
          "stdio MCP connections use command instead of url",
        );
      result.command = requiredString(value.command, "command");
      result.args = optionalStrings(value.args, "args") ?? [];
      result.env = optionalStringTable(value.env, "env") ?? {};
      result.secretEnv = optionalStrings(value.secret_env, "secret_env") ?? [];
      if (new Set(result.secretEnv).size !== result.secretEnv.length)
        throw new IntegralError("secret_env must contain unique names");
      if (
        result.secretEnv.some(
          (name) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            Object.hasOwn(result.env!, name),
        )
      )
        throw new IntegralError(
          "secret_env names must be valid and distinct from env",
        );
      result.allowedUrls = (
        optionalStrings(value.allowed_urls, "allowed_urls") ?? []
      ).map((candidate) => secureUrl(candidate, "allowed_urls"));
      for (const forbidden of [
        "authorization_url",
        "token_url",
        "device_authorization_url",
        "registration_url",
        "client_id",
        "scopes",
        "oauth_issuer",
        "oauth_resource",
        "header",
        "scheme",
        "methods",
        "path_prefix",
      ])
        if (value[forbidden] !== undefined)
          throw new IntegralError(`${forbidden} is not supported by stdio MCP`);
    } else {
      if (
        value.command !== undefined ||
        value.args !== undefined ||
        value.env !== undefined ||
        value.secret_env !== undefined ||
        value.allowed_urls !== undefined
      )
        throw new IntegralError(
          "command, args, env, secret_env, and allowed_urls are only for stdio MCP",
        );
    }
  } else if (
    value.command !== undefined ||
    value.args !== undefined ||
    value.env !== undefined ||
    value.secret_env !== undefined ||
    value.allowed_urls !== undefined
  ) {
    throw new IntegralError(
      "command, args, env, secret_env, and allowed_urls are only for stdio MCP",
    );
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
  if (hostResource) {
    const path = requiredString(value.path, "path"),
      mount = requiredString(value.mount, "mount");
    if (!isAbsolute(path)) throw new IntegralError("path must be absolute");
    if (!isAbsolute(mount) || normalize(mount) !== mount)
      throw new IntegralError("mount must be an absolute normalized path");
    if (mount === "/home/pi" || !mount.startsWith("/home/pi/"))
      throw new IntegralError("mount must be below /home/pi");
    const relativeMount = mount.slice("/home/pi/".length);
    const piProfile = name === "pi-profile";
    if (
      piProfile &&
      (kind !== "host-repo" ||
        (mount !== "/home/pi/.pi" && mount !== "/home/pi/.pi/agent"))
    )
      throw new IntegralError(
        "pi-profile must be a host repository mounted at /home/pi/.pi",
      );
    if (
      !piProfile &&
      [".pi", "history"].some(
        (reserved) =>
          relativeMount === reserved ||
          relativeMount.startsWith(`${reserved}/`),
      )
    )
      throw new IntegralError("mount overlaps an Integral control path");
    result.path = path;
    result.mount = mount;
    if (kind === "host-repo") {
      if (value.branch !== undefined)
        result.branch = requiredString(value.branch, "branch");
    } else if (value.branch !== undefined) {
      throw new IntegralError("branch is supported only by host-repo");
    }
    for (const forbidden of [
      "provider",
      "url",
      "hosts",
      "methods",
      "capabilities",
    ])
      if (value[forbidden] !== undefined)
        throw new IntegralError(
          `${forbidden} is not supported by host resources`,
        );
  } else if (
    value.path !== undefined ||
    value.branch !== undefined ||
    value.mount !== undefined
  ) {
    throw new IntegralError(
      "path, branch, and mount are only for host resources",
    );
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
    ["registration_url", c.registrationUrl],
    ["client_id", c.clientId],
    ["oauth_issuer", c.oauthIssuer],
    ["oauth_resource", c.oauthResource],
    ["transport", c.transport],
    ["command", c.command],
    ["account", c.account],
    ["domain", c.domain],
    ["from_address", c.fromAddress],
    ["region", c.region],
    ["path", c.path],
    ["branch", c.branch],
    ["mount", c.mount],
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
  if (c.args) rows.push(`args = [${c.args.map(quote).join(", ")}]`);
  if (c.secretEnv)
    rows.push(`secret_env = [${c.secretEnv.map(quote).join(", ")}]`);
  if (c.allowedUrls)
    rows.push(`allowed_urls = [${c.allowedUrls.map(quote).join(", ")}]`);
  if (c.env && Object.keys(c.env).length)
    rows.push(
      `env = { ${Object.entries(c.env)
        .map(([name, value]) => `${name} = ${quote(value)}`)
        .join(", ")} }`,
    );
  return `${rows.join("\n")}\n`;
}

export function connectionBoundaries(connection: Connection): URL[] {
  if (connection.provider === "github")
    return (connection.hosts ?? []).map((host) => new URL(`https://${host}/`));
  return [
    ...(connection.url ? [new URL(connection.url)] : []),
    ...(connection.allowedUrls ?? []).map((url) => new URL(url)),
  ];
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
  const resourceModule = await import("./resources.ts"),
    records = await resourceModule.listResourceRecords(paths),
    hostRecords = new Map(
      (
        await Promise.all(
          records.map((record) =>
            resourceModule.refreshResource(paths, record),
          ),
        )
      ).map((record) => [record.connection, record]),
    );
  return Promise.all(
    loaded.connections.map(async (c) => {
      const resource = hostRecords.get(c.name),
        health = resource ? undefined : await connectionHealth(paths, c.name),
        usable =
          (c.auth === "none" && !c.secretEnv?.length) ||
          usableCredential(c, await credentialFor(paths, c.name));
      return {
        ...c,
        state: resource
          ? resource.state
          : !usable
            ? "DISABLED (no secret)"
            : health
              ? "degraded"
              : "active",
        ...(resource
          ? {
              resourceId: resource.id,
              lifecycleRevision: resource.revision,
              restorationPossible:
                await resourceModule.resourceRestorationPossible(resource),
              ...(resource.availabilityReason
                ? { availabilityReason: resource.availabilityReason }
                : {}),
            }
          : {}),
        ...(!resource && health ? { availabilityReason: health } : {}),
      } satisfies ListedConnection;
    }),
  );
}
function usableCredential(
  connection: Connection,
  raw: string | undefined,
): boolean {
  if (!raw?.trim()) return false;
  if (connection.transport === "stdio") {
    try {
      const value = JSON.parse(raw) as Partial<StdioCredential>;
      return (
        value.type === "stdio-env" &&
        Boolean(value.values) &&
        (connection.secretEnv ?? []).every(
          (name) => typeof value.values?.[name] === "string",
        )
      );
    } catch {
      return false;
    }
  }
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
  const file = join(paths.state, "connection-generation"),
    sessionFile = join(paths.state, "session-generation"),
    current = Number((await readText(file))?.trim() || "0");
  const next = Number.isSafeInteger(current) ? current + 1 : 1;
  await Promise.all([
    atomicWrite(file, `${next}\n`),
    atomicWrite(sessionFile, `${next}\n`),
  ]);
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
  if (
    (connection.auth !== "none" || connection.secretEnv?.length) &&
    !credential
  )
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
      (current.auth === "none" && !current.secretEnv?.length) ||
      current.kind !== connection.kind ||
      current.provider !== connection.provider ||
      current.auth !== connection.auth ||
      JSON.stringify(current.secretEnv ?? []) !==
        JSON.stringify(connection.secretEnv ?? [])
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

export async function migratePiProfileConnection(
  paths: IntegralPaths,
  expectedPath: string,
): Promise<void> {
  const declaration = join(paths.connections, "pi-profile.toml"),
    raw = await readText(declaration);
  if (raw === undefined)
    throw new IntegralError("pi-profile connection is missing");
  const current = validateConnection(parse(raw), "pi-profile");
  if (
    current.kind !== "host-repo" ||
    current.auth !== "none" ||
    current.path !== expectedPath ||
    current.mount !== "/home/pi/.pi/agent" ||
    current.branch !== "main"
  )
    throw new IntegralError("pi-profile connection cannot be migrated");
  await atomicWrite(
    declaration,
    connectionToml({ ...current, mount: "/home/pi/.pi" }),
  );
  await bumpGeneration(paths);
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
  await clearConnectionDegraded(paths, name);
  await bumpGeneration(paths);
}

export async function prepareStorage(paths: IntegralPaths): Promise<void> {
  await ensureDir(paths.connections);
  await ensureDir(paths.credentials);
}
