import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Connection } from "./connections.ts";
import { RrError } from "./errors.ts";

export interface OAuthUi { show(message: string): void; prompt(message: string): Promise<string>; select?(message: string, options: { id: string; label: string }[]): Promise<string | undefined> }
interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
export interface StoredOAuth { type: "oauth"; access: string; refresh?: string; expires: number }

export async function runModelOAuth(provider: string, method: "oauth" | "device-code", ui: OAuthUi): Promise<string> {
  const storage = AuthStorage.inMemory();
  await storage.login(provider, {
    onAuth: (info) => ui.show(`${info.instructions ? `${info.instructions}\n` : ""}${info.url}`),
    onDeviceCode: (info) => ui.show(`Open ${info.verificationUri} and enter code ${info.userCode}`),
    onPrompt: async (prompt) => ui.prompt(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `),
    onProgress: (message) => ui.show(message),
    onSelect: async (prompt) => method === "device-code" ? prompt.options.find((o) => o.id.includes("device"))?.id : prompt.options.find((o) => o.id.includes("browser"))?.id ?? prompt.options[0]?.id,
  });
  const credential = storage.get(provider); if (!credential || credential.type !== "oauth") throw new RrError(`${provider} OAuth did not return a usable credential`);
  return JSON.stringify(credential);
}

export async function runGenericOAuth(connection: Connection, ui: OAuthUi, request: typeof fetch = fetch): Promise<string> {
  if (connection.auth === "device-code") return JSON.stringify(await deviceCode(connection, ui, request));
  if (connection.auth !== "oauth") throw new RrError("generic OAuth requires oauth or device-code authentication");
  return JSON.stringify(await authorizationCode(connection, ui, request));
}

async function deviceCode(connection: Connection, ui: OAuthUi, request: typeof fetch): Promise<StoredOAuth> {
  const start = await postForm(connection.deviceAuthorizationUrl!, { client_id: connection.clientId!, scope: connection.scopes?.join(" ") ?? "" }, request);
  const device = await start.json() as { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; interval?: number; expires_in?: number; error?: string };
  if (!start.ok || !device.device_code || !device.user_code || !device.verification_uri) throw new RrError(`device authorization failed: ${device.error ?? start.status}`);
  ui.show(`Open ${device.verification_uri_complete ?? device.verification_uri} and enter code ${device.user_code}`);
  const deadline = Date.now() + (device.expires_in ?? 600) * 1000; let interval = (device.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval)); const response = await postForm(connection.tokenUrl!, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: connection.clientId! }, request); const token = await response.json() as TokenResponse;
    if (response.ok && token.access_token) return stored(token); if (token.error === "authorization_pending") continue; if (token.error === "slow_down") { interval += 5000; continue; } throw new RrError(`device authorization failed: ${token.error_description ?? token.error ?? response.status}`);
  }
  throw new RrError("device authorization timed out");
}

async function authorizationCode(connection: Connection, ui: OAuthUi, request: typeof fetch): Promise<StoredOAuth> {
  const verifier = randomBytes(48).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url"), state = randomBytes(24).toString("base64url");
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void; const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = http.createServer((req, res) => { const url = new URL(req.url ?? "/", "http://callback"); if (url.searchParams.get("state") !== state) { res.writeHead(400).end("Invalid OAuth state"); return; } const value = url.searchParams.get("code"); if (!value) { const error = new RrError(`OAuth failed: ${url.searchParams.get("error") ?? "missing code"}`); rejectCode(error); res.writeHead(400).end(error.message); return; } resolveCode(value); res.end("rr connection authorized; return to the terminal.\n"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); const port = (server.address() as { port: number }).port, redirect = `http://127.0.0.1:${port}/callback`;
  const authorization = new URL(connection.authorizationUrl!); authorization.searchParams.set("response_type", "code"); authorization.searchParams.set("client_id", connection.clientId!); authorization.searchParams.set("redirect_uri", redirect); authorization.searchParams.set("state", state); authorization.searchParams.set("code_challenge", challenge); authorization.searchParams.set("code_challenge_method", "S256"); if (connection.scopes?.length) authorization.searchParams.set("scope", connection.scopes.join(" ")); ui.show(`Open this URL to authorize ${connection.name}:\n${authorization}`);
  try { const authCode = await Promise.race([code, new Promise<never>((_, reject) => setTimeout(() => reject(new RrError("OAuth authorization timed out")), 600_000))]); const response = await postForm(connection.tokenUrl!, { grant_type: "authorization_code", code: authCode, redirect_uri: redirect, client_id: connection.clientId!, code_verifier: verifier }, request); const token = await response.json() as TokenResponse; if (!response.ok || !token.access_token) throw new RrError(`OAuth token exchange failed: ${token.error_description ?? token.error ?? response.status}`); return stored(token); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function stored(token: TokenResponse): StoredOAuth { const result: StoredOAuth = { type: "oauth", access: token.access_token!, expires: Date.now() + (token.expires_in ?? 3600) * 1000 }; if (token.refresh_token) result.refresh = token.refresh_token; return result; }
function postForm(url: string, values: Record<string, string>, request: typeof fetch): Promise<Response> { return request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(values) }); }

export function oauthAccess(raw: string): string | undefined { try { const value = JSON.parse(raw) as { type?: string; access?: string }; return value.type === "oauth" && typeof value.access === "string" ? value.access : undefined; } catch { return undefined; } }

export async function refreshOAuth(connection: Connection, raw: string, request: typeof fetch = fetch): Promise<{ access: string; serialized: string }> {
  const parsed = JSON.parse(raw) as StoredOAuth & Record<string, unknown>; if (parsed.type !== "oauth" || !parsed.access) throw new RrError(`connection ${connection.name} has an invalid OAuth credential`);
  if (parsed.expires > Date.now() + 60_000) return { access: parsed.access, serialized: raw };
  if (connection.kind === "model") { const storage = AuthStorage.inMemory({ [connection.provider!]: parsed as never }); const access = await storage.getApiKey(connection.provider!, { includeFallback: false }); const current = storage.get(connection.provider!); if (!access || !current) throw new RrError(`OAuth refresh failed for ${connection.name}`); return { access, serialized: JSON.stringify(current) }; }
  if (!parsed.refresh) throw new RrError(`OAuth credential expired for ${connection.name}; rotate or reconfigure it`);
  const response = await postForm(connection.tokenUrl!, { grant_type: "refresh_token", refresh_token: parsed.refresh, client_id: connection.clientId! }, request); const token = await response.json() as TokenResponse; if (!response.ok || !token.access_token) throw new RrError(`OAuth refresh failed for ${connection.name}: ${token.error_description ?? token.error ?? response.status}`); if (!token.refresh_token) token.refresh_token = parsed.refresh; const next = stored(token); return { access: next.access, serialized: JSON.stringify(next) };
}
