import type { IncomingHttpHeaders } from "node:http";
import type { Connection } from "./connections.ts";
import { RrError } from "./errors.ts";

export const SENTINEL = "rr-managed-credential";
export interface CredentialedConnection {
  connection: Connection;
  credential: string | undefined;
  injectedHeaders?: Record<string, string>;
}
export interface GatewayDecision {
  connection: Connection;
  url: URL;
  headers: Record<string, string | string[]>;
}

function normalizePort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}
function prefixMatches(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function decideRequest(
  method: string,
  target: URL,
  headers: IncomingHttpHeaders,
  candidates: readonly CredentialedConnection[],
): GatewayDecision {
  const match = candidates.find(({ connection }) => {
    if (!connection.url) return false;
    const boundary = new URL(connection.url);
    const methods = connection.methods ?? ["*"];
    return (
      boundary.protocol === target.protocol &&
      boundary.hostname.toLowerCase() === target.hostname.toLowerCase() &&
      normalizePort(boundary) === normalizePort(target) &&
      methods.some((m) => m === "*" || m === method.toUpperCase()) &&
      prefixMatches(target.pathname, connection.pathPrefix ?? boundary.pathname)
    );
  });
  if (!match) throw new RrError("policy denied the requested destination", 403);
  const clean: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      !["proxy-authorization", "proxy-connection"].includes(key.toLowerCase())
    )
      clean[key] = value;
  }
  if (match.connection.auth !== "none") {
    if (!match.credential)
      throw new RrError(
        `connection ${match.connection.name} has no usable credential; rotate or reconfigure it`,
        403,
      );
    const header = (match.connection.header ?? "Authorization").toLowerCase();
    const incoming = clean[header];
    if (
      incoming !== undefined &&
      !String(incoming).toLowerCase().includes(SENTINEL)
    )
      throw new RrError("gateway refused an unmanaged credential", 403);
    clean[header] =
      `${match.connection.scheme ?? "Bearer"} ${match.credential}`.trim();
    for (const [name, value] of Object.entries(match.injectedHeaders ?? {}))
      clean[name.toLowerCase()] = value;
  }
  return { connection: match.connection, url: target, headers: clean };
}

export function parseProxyAuthorization(
  value: string | undefined,
): string | undefined {
  if (!value?.startsWith("Basic ")) return undefined;
  try {
    const decoded = Buffer.from(value.slice(6), "base64").toString();
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : undefined;
  } catch {
    return undefined;
  }
}
