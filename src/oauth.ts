import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { Connection } from "./connections.ts";
import { IntegralError } from "./errors.ts";
import type { IntegralPaths } from "./paths.ts";
import {
  ensurePiRuntime,
  loadPiRuntimeModule,
  type PiRuntimeModule,
  type PiRuntimeResolution,
  type PiAuthEvent,
  type PiAuthPrompt,
  type PiCredential,
  type PiCredentialStore,
} from "./pi-runtime.ts";

export interface OAuthUi {
  show(message: string): void;
  prompt(message: string, signal?: AbortSignal): Promise<string>;
  select?(
    message: string,
    options: { id: string; label: string }[],
  ): Promise<string | undefined>;
}
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}
export interface StoredOAuth {
  type: "oauth";
  access: string;
  refresh?: string;
  expires: number;
  clientId?: string;
  clientSecret?: string;
  issuer?: string;
  resource?: string;
}
export interface OAuthCallback {
  redirect: string;
  code: Promise<string>;
  close(): Promise<void>;
}
export type OAuthCallbackFactory = (
  state: string,
  expectedIssuer?: string,
) => Promise<OAuthCallback>;

export async function runModelOAuth(
  paths: IntegralPaths,
  provider: string,
  method: "oauth" | "device-code",
  ui: OAuthUi,
  runtime: {
    ensure(paths: IntegralPaths): Promise<PiRuntimeResolution>;
    load(resolution: PiRuntimeResolution): Promise<PiRuntimeModule>;
  } = { ensure: ensurePiRuntime, load: loadPiRuntimeModule },
): Promise<string> {
  const resolution = await runtime.ensure(paths);
  if (resolution.warning) ui.show(`Warning: ${resolution.warning}`);
  const module = await runtime.load(resolution);
  const manualAbort = new AbortController();
  let credential: unknown;
  try {
    if (module.ModelRuntime) {
      const models = await module.ModelRuntime.create({
        credentials: memoryCredentialStore(provider),
      });
      credential = await models.login(provider, "oauth", {
        signal: manualAbort.signal,
        notify: (event) => showPiAuthEvent(event, ui),
        prompt: (prompt) =>
          answerPiAuthPrompt(prompt, method, ui, manualAbort.signal),
      });
    } else if (module.AuthStorage) {
      const storage = module.AuthStorage.inMemory();
      await storage.login(provider, {
        onAuth: (info) =>
          ui.show(
            `${info.instructions ? `${info.instructions}\n` : ""}${info.url}`,
          ),
        onDeviceCode: (info) =>
          ui.show(
            `Open ${info.verificationUri} and enter code ${info.userCode}`,
          ),
        onPrompt: async (prompt) =>
          ui.prompt(
            `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `,
          ),
        onManualCodeInput: () =>
          ui.prompt(
            "Paste the authorization code or full redirect URL: ",
            manualAbort.signal,
          ),
        onProgress: (message) => ui.show(message),
        onSelect: async (prompt) => selectPiAuthOption(prompt.options, method),
      });
      credential = storage.get(provider);
    }
  } finally {
    manualAbort.abort();
  }
  const checked = credential as
    | { type?: unknown; access?: unknown; refresh?: unknown; expires?: unknown }
    | undefined;
  if (
    !checked ||
    checked.type !== "oauth" ||
    typeof checked.access !== "string" ||
    typeof checked.expires !== "number"
  )
    throw new IntegralError(
      `${provider} OAuth did not return a usable credential`,
    );
  return JSON.stringify(checked);
}

function selectPiAuthOption(
  options: ReadonlyArray<{ id: string }>,
  method: "oauth" | "device-code",
): string {
  return (
    (
      (method === "device-code"
        ? options.find((option) => option.id.includes("device"))
        : options.find((option) => option.id.includes("browser"))) ?? options[0]
    )?.id ?? ""
  );
}

function showPiAuthEvent(event: PiAuthEvent, ui: OAuthUi): void {
  if (event.type === "auth_url")
    ui.show(
      `${event.instructions ? `${event.instructions}\n` : ""}${event.url}`,
    );
  else if (event.type === "device_code")
    ui.show(`Open ${event.verificationUri} and enter code ${event.userCode}`);
  else ui.show(event.message);
}

async function answerPiAuthPrompt(
  prompt: PiAuthPrompt,
  method: "oauth" | "device-code",
  ui: OAuthUi,
  signal: AbortSignal,
): Promise<string> {
  if (prompt.type === "select")
    return (
      (await ui.select?.(prompt.message, [...prompt.options])) ??
      selectPiAuthOption(prompt.options, method)
    );
  return ui.prompt(
    `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `,
    prompt.signal ?? signal,
  );
}

export async function runGenericOAuth(
  connection: Connection,
  ui: OAuthUi,
  request: typeof fetch = fetch,
  callbackFactory: OAuthCallbackFactory = startLocalOAuthCallback,
): Promise<string> {
  if (connection.auth === "device-code")
    return JSON.stringify(await deviceCode(connection, ui, request));
  if (connection.auth !== "oauth")
    throw new IntegralError(
      "generic OAuth requires oauth or device-code authentication",
    );
  return JSON.stringify(
    await authorizationCode(connection, ui, request, callbackFactory),
  );
}

async function deviceCode(
  connection: Connection,
  ui: OAuthUi,
  request: typeof fetch,
): Promise<StoredOAuth> {
  const start = await postForm(
    connection.deviceAuthorizationUrl!,
    {
      client_id: connection.clientId!,
      scope: connection.scopes?.join(" ") ?? "",
    },
    request,
  );
  const device = (await start.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
    error?: string;
  };
  if (
    !start.ok ||
    !device.device_code ||
    !device.user_code ||
    !device.verification_uri
  )
    throw new IntegralError(
      `device authorization failed: ${device.error ?? start.status}`,
    );
  ui.show(
    `Open ${device.verification_uri_complete ?? device.verification_uri} and enter code ${device.user_code}`,
  );
  const deadline = Date.now() + (device.expires_in ?? 600) * 1000;
  let interval = (device.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const response = await postForm(
      connection.tokenUrl!,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: connection.clientId!,
      },
      request,
    );
    const token = (await response.json()) as TokenResponse;
    if (response.ok && token.access_token) return stored(token);
    if (token.error === "authorization_pending") continue;
    if (token.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new IntegralError(
      `device authorization failed: ${token.error_description ?? token.error ?? response.status}`,
    );
  }
  throw new IntegralError("device authorization timed out");
}

async function authorizationCode(
  connection: Connection,
  ui: OAuthUi,
  request: typeof fetch,
  callbackFactory: OAuthCallbackFactory,
): Promise<StoredOAuth> {
  const verifier = randomBytes(48).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url"),
    state = randomBytes(24).toString("base64url");
  const callback = await callbackFactory(state, connection.oauthIssuer);
  const redirect = callback.redirect;
  let clientId = connection.clientId,
    clientSecret: string | undefined;
  if (!clientId && connection.registrationUrl) {
    const registration = await request(connection.registrationUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_name: "Integral",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "native",
        }),
      }),
      registered = (await registration.json()) as {
        client_id?: string;
        client_secret?: string;
        error?: string;
      };
    if (!registration.ok || !registered.client_id)
      throw new IntegralError(
        `OAuth client registration failed: ${registered.error ?? registration.status}`,
      );
    clientId = registered.client_id;
    clientSecret = registered.client_secret;
  }
  if (!clientId)
    throw new IntegralError("OAuth authorization requires a client ID");
  const authorization = new URL(connection.authorizationUrl!);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", redirect);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  if (connection.scopes?.length)
    authorization.searchParams.set("scope", connection.scopes.join(" "));
  if (connection.oauthResource)
    authorization.searchParams.set("resource", connection.oauthResource);
  if (connection.kind === "email" && connection.provider === "gmail") {
    authorization.searchParams.set("access_type", "offline");
    authorization.searchParams.set("prompt", "consent");
  }
  ui.show(`Open this URL to authorize ${connection.name}:\n${authorization}`);
  const manualAbort = new AbortController();
  const never = () => new Promise<never>(() => undefined);
  const manualCode = ui
    .prompt(
      "Paste the authorization code or full redirect URL (or wait for the local callback): ",
      manualAbort.signal,
    )
    .then((value) =>
      value.trim()
        ? authorizationCodeFromInput(value, state, connection.oauthIssuer)
        : never(),
    )
    .catch((error: unknown) => {
      if (manualAbort.signal.aborted) return never();
      throw error;
    });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const authCode = await Promise.race([
      callback.code,
      manualCode,
      new Promise<never>(
        (_, reject) =>
          (timeout = setTimeout(
            () => reject(new IntegralError("OAuth authorization timed out")),
            600_000,
          )),
      ),
    ]);
    const tokenValues: Record<string, string> = {
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    };
    if (clientSecret) tokenValues.client_secret = clientSecret;
    if (connection.oauthResource)
      tokenValues.resource = connection.oauthResource;
    const response = await postForm(connection.tokenUrl!, tokenValues, request);
    const token = (await response.json()) as TokenResponse;
    if (!response.ok || !token.access_token)
      throw new IntegralError(
        `OAuth token exchange failed: ${token.error_description ?? token.error ?? response.status}`,
      );
    return stored(token, {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(connection.oauthIssuer ? { issuer: connection.oauthIssuer } : {}),
      ...(connection.oauthResource
        ? { resource: connection.oauthResource }
        : {}),
    });
  } finally {
    manualAbort.abort();
    if (timeout) clearTimeout(timeout);
    await callback.close();
  }
}

async function startLocalOAuthCallback(
  state: string,
  expectedIssuer?: string,
): Promise<OAuthCallback> {
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://callback");
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("Invalid OAuth state");
      return;
    }
    if (expectedIssuer && url.searchParams.get("iss") !== expectedIssuer) {
      res.writeHead(400).end("Invalid OAuth issuer");
      return;
    }
    const value = url.searchParams.get("code");
    if (!value) {
      const error = new IntegralError(
        `OAuth failed: ${url.searchParams.get("error") ?? "missing code"}`,
      );
      rejectCode(error);
      res.writeHead(400).end(error.message);
      return;
    }
    resolveCode(value);
    res.end("integral connection authorized; return to the terminal.\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    redirect: `http://127.0.0.1:${port}/callback`,
    code,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function authorizationCodeFromInput(
  input: string,
  expectedState: string,
  expectedIssuer?: string,
): string {
  const value = input.trim();
  if (!value) throw new IntegralError("missing OAuth authorization code");
  if (/^https?:\/\//i.test(value)) {
    let redirect: URL;
    try {
      redirect = new URL(value);
    } catch {
      throw new IntegralError("invalid OAuth redirect URL");
    }
    const state = redirect.searchParams.get("state");
    if (state && state !== expectedState)
      throw new IntegralError("OAuth state mismatch");
    const issuer = redirect.searchParams.get("iss");
    if (expectedIssuer && issuer !== expectedIssuer)
      throw new IntegralError("OAuth issuer mismatch");
    const code = redirect.searchParams.get("code");
    if (!code) throw new IntegralError("OAuth redirect URL is missing code");
    return code;
  }
  return value;
}

function stored(
  token: TokenResponse,
  metadata: Partial<StoredOAuth> = {},
): StoredOAuth {
  const result: StoredOAuth = {
    type: "oauth",
    access: token.access_token!,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
    ...metadata,
  };
  if (token.refresh_token) result.refresh = token.refresh_token;
  return result;
}
function postForm(
  url: string,
  values: Record<string, string>,
  request: typeof fetch,
): Promise<Response> {
  return request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(values),
  });
}

export function oauthAccess(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as { type?: string; access?: string };
    return value.type === "oauth" && typeof value.access === "string"
      ? value.access
      : undefined;
  } catch {
    return undefined;
  }
}

export async function refreshOAuth(
  paths: IntegralPaths,
  connection: Connection,
  raw: string,
  request: typeof fetch = fetch,
): Promise<{ access: string; serialized: string }> {
  const parsed = JSON.parse(raw) as StoredOAuth & Record<string, unknown>;
  if (parsed.type !== "oauth" || !parsed.access)
    throw new IntegralError(
      `connection ${connection.name} has an invalid OAuth credential`,
    );
  if (parsed.expires > Date.now() + 60_000)
    return { access: parsed.access, serialized: raw };
  if (connection.kind === "model") {
    const runtime = await ensurePiRuntime(paths);
    const module = await loadPiRuntimeModule(runtime);
    let access: string | undefined, current: unknown;
    if (module.ModelRuntime) {
      const store = memoryCredentialStore(connection.provider!, parsed),
        models = await module.ModelRuntime.create({ credentials: store }),
        resolved = await models.getAuth(connection.provider!, {
          minOAuthValidityMs: 60_000,
        });
      access =
        resolved?.auth.apiKey ??
        bearerValue(resolved?.auth.headers?.authorization);
      current = await store.read(connection.provider!);
    } else if (module.AuthStorage) {
      const storage = module.AuthStorage.inMemory({
        [connection.provider!]: parsed,
      });
      access = await storage.getApiKey(connection.provider!, {
        includeFallback: false,
      });
      current = storage.get(connection.provider!);
    }
    if (!access || !current)
      throw new IntegralError(`OAuth refresh failed for ${connection.name}`);
    return { access, serialized: JSON.stringify(current) };
  }
  if (!parsed.refresh)
    throw new IntegralError(
      `OAuth credential expired for ${connection.name}; rotate or reconfigure it`,
    );
  const response = await postForm(
    connection.tokenUrl!,
    {
      grant_type: "refresh_token",
      refresh_token: parsed.refresh,
      client_id: parsed.clientId ?? connection.clientId!,
      ...(parsed.clientSecret ? { client_secret: parsed.clientSecret } : {}),
      ...((parsed.resource ?? connection.oauthResource)
        ? { resource: (parsed.resource ?? connection.oauthResource)! }
        : {}),
    },
    request,
  );
  const token = (await response.json()) as TokenResponse;
  if (!response.ok || !token.access_token)
    throw new IntegralError(
      `OAuth refresh failed for ${connection.name}: ${token.error_description ?? token.error ?? response.status}`,
    );
  if (!token.refresh_token) token.refresh_token = parsed.refresh;
  const next = stored(token, {
    ...(parsed.clientId ? { clientId: parsed.clientId } : {}),
    ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
    ...(parsed.issuer ? { issuer: parsed.issuer } : {}),
    ...(parsed.resource ? { resource: parsed.resource } : {}),
  });
  return { access: next.access, serialized: JSON.stringify(next) };
}

function bearerValue(value: string | undefined): string | undefined {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function memoryCredentialStore(
  provider: string,
  initial?: PiCredential,
): PiCredentialStore {
  let credential: PiCredential | undefined = initial
    ? { ...initial }
    : undefined;
  return {
    async read(requested) {
      return requested === provider && credential
        ? { ...credential }
        : undefined;
    },
    async list() {
      return credential
        ? [{ providerId: provider, type: credential.type }]
        : [];
    },
    async modify(requested, update) {
      if (requested !== provider) return undefined;
      const next = await update(credential ? { ...credential } : undefined);
      if (next !== undefined) credential = { ...next };
      return credential ? { ...credential } : undefined;
    },
    async delete(requested) {
      if (requested === provider) credential = undefined;
    },
  };
}
