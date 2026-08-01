import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import type { Connection } from "./connections.ts";
import { credentialFor, loadConnections } from "./connections.ts";
import type { RrPaths } from "./paths.ts";
import type { EffectiveConfig } from "./config.ts";
import {
  decideRequest,
  parseProxyAuthorization,
  type CredentialedConnection,
} from "./gateway-policy.ts";
import { certificateFor, ensureCa, type CaFiles } from "./ca.ts";
import {
  componentIdentity,
  deploymentId,
  readComponentState,
  updateComponentState,
  verifyInternal,
} from "./state.ts";
import { RrError } from "./errors.ts";
import type { Logger } from "./logging.ts";
import { oauthAccess, refreshOAuth } from "./oauth.ts";
import { atomicWrite } from "./fs.ts";
import { readText } from "./fs.ts";
import { join } from "node:path";

function modelBoundary(connection: Connection): Connection {
  if (connection.kind !== "model") return connection;
  return {
    ...connection,
    url:
      connection.provider === "anthropic"
        ? "https://api.anthropic.com/"
        : "https://chatgpt.com/backend-api/",
    methods: ["*"],
  };
}

export class Gateway {
  readonly sessions = new Map<string, string>();
  private servers: http.Server[] = [];
  private ca?: CaFiles;
  private token = "";
  private candidates: CredentialedConnection[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private lastConnectionHash: string | undefined;
  private lastGeneration = 0;
  private sawInvalidConnections = false;
  constructor(
    private readonly paths: RrPaths,
    private readonly config: EffectiveConfig,
    private readonly logger: Logger,
  ) {}
  async start(): Promise<http.Server> {
    this.ca = await ensureCa(this.paths);
    this.token = await componentIdentity(this.paths);
    await this.reload(true);
    const server = this.makeServer();
    this.servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.server.gatewayPort, "127.0.0.1", resolve);
    });
    this.refreshTimer = setInterval(() => void this.reload(false), 500);
    return server;
  }
  private makeServer(): http.Server {
    const server = http.createServer((req, res) => void this.route(req, res));
    server.on(
      "connect",
      (req, socket, head) => void this.connect(req, socket, head),
    );
    return server;
  }
  async reload(strict = false): Promise<void> {
    const loaded = await loadConnections(this.paths);
    if (strict && loaded.errors.length)
      throw new RrError(loaded.errors.join("\n"));
    const credentialErrors: string[] = [];
    this.candidates = await Promise.all(
      loaded.connections.map(async (connection) => {
        const raw = await credentialFor(this.paths, connection.name);
        let credential = raw,
          injectedHeaders: Record<string, string> | undefined;
        if (raw && oauthAccess(raw))
          try {
            const refreshed = await refreshOAuth(connection, raw);
            credential = refreshed.access;
            if (refreshed.serialized !== raw)
              await atomicWrite(
                join(this.paths.credentials, connection.name),
                refreshed.serialized,
              );
          } catch (error) {
            credential = undefined;
            credentialErrors.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        if (raw && connection.provider === "openai-codex")
          try {
            const accountId = (JSON.parse(raw) as { accountId?: unknown })
              .accountId;
            if (typeof accountId === "string")
              injectedHeaders = { "chatgpt-account-id": accountId };
          } catch {
            /* opaque credential */
          }
        return {
          connection: modelBoundary(connection),
          credential,
          ...(injectedHeaders ? { injectedHeaders } : {}),
        };
      }),
    );
    const generationFile = join(this.paths.state, "connection-generation"),
      current = Number((await readText(generationFile))?.trim() || "0"),
      hash = createHash("sha256")
        .update(JSON.stringify(loaded.connections))
        .digest("hex");
    let generation = current;
    if (
      !strict &&
      loaded.errors.length === 0 &&
      this.lastConnectionHash !== undefined &&
      (hash !== this.lastConnectionHash || this.sawInvalidConnections) &&
      current === this.lastGeneration
    ) {
      generation = current + 1;
      await atomicWrite(generationFile, `${generation}\n`);
    }
    if (loaded.errors.length) this.sawInvalidConnections = true;
    else {
      this.lastConnectionHash = hash;
      this.sawInvalidConnections = false;
    }
    this.lastGeneration = generation;
    const errors = [...loaded.errors, ...credentialErrors];
    await updateComponentState(
      this.paths,
      "gateway",
      errors.length
        ? {
            connectionGeneration: generation,
            status: "degraded",
            error: errors.join("\n"),
          }
        : { connectionGeneration: generation, status: "ready" },
    );
  }
  private authenticate(req: IncomingMessage): string | undefined {
    const token = parseProxyAuthorization(req.headers["proxy-authorization"]);
    return token && this.sessions.get(token);
  }
  private async route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.url === "/rr/health") {
      const state = await readComponentState(this.paths, "gateway");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          component: "gateway",
          deploymentId: deploymentId(this.paths),
          status: state?.status ?? "ready",
          error: state?.error,
        }),
      );
      return;
    }
    if (req.url === "/rr/internal/session" && req.method === "POST") {
      if (
        !verifyInternal(
          req.headers,
          "runner",
          this.token,
          deploymentId(this.paths),
        )
      ) {
        res.writeHead(401).end("unauthorized\n");
        return;
      }
      const body = await bodyJson(req);
      const token = stringValue(body.token),
        sessionId = stringValue(body.sessionId);
      if (!token || !sessionId) {
        res.writeHead(400).end("invalid session\n");
        return;
      }
      this.sessions.set(token, sessionId);
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/rr/internal/docker-listener" && req.method === "POST") {
      if (
        !verifyInternal(
          req.headers,
          "runner",
          this.token,
          deploymentId(this.paths),
        )
      ) {
        res.writeHead(401).end("unauthorized\n");
        return;
      }
      const body = await bodyJson(req),
        address = stringValue(body.address);
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
        res.writeHead(400).end("invalid address\n");
        return;
      }
      if (
        !this.servers.some(
          (s) =>
            (s.address() as { address?: string } | null)?.address === address,
        )
      ) {
        const dockerServer = this.makeServer();
        await new Promise<void>((resolve, reject) => {
          dockerServer.once("error", reject);
          dockerServer.listen(this.config.server.gatewayPort, address, resolve);
        });
        this.servers.push(dockerServer);
      }
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/rr/internal/session" && req.method === "DELETE") {
      if (
        !verifyInternal(
          req.headers,
          "runner",
          this.token,
          deploymentId(this.paths),
        )
      ) {
        res.writeHead(401).end("unauthorized\n");
        return;
      }
      const body = await bodyJson(req);
      this.sessions.delete(stringValue(body.token));
      res.writeHead(204).end();
      return;
    }
    const sessionId = this.authenticate(req);
    if (!sessionId) {
      res
        .writeHead(407, { "proxy-authenticate": "Basic realm=rr" })
        .end("proxy authentication required\n");
      return;
    }
    let target: URL | undefined;
    try {
      target = new URL(req.url!);
      await this.forward(req, res, target, sessionId);
    } catch (error) {
      this.logger.event("info", "gateway.decision", "gateway denied request", {
        verdict:
          error instanceof RrError && error.exitCode === 403
            ? "policy-deny"
            : "request-failed",
        method: req.method,
        host: target?.hostname ?? "invalid",
        port: target?.port || (target?.protocol === "https:" ? 443 : 80),
        session_id: sessionId,
        request_id: randomUUID(),
      });
      respondError(res, error);
    }
  }
  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    sessionId: string,
  ): Promise<void> {
    const requestId = randomUUID();
    const decision = decideRequest(
      req.method ?? "GET",
      target,
      req.headers,
      this.candidates,
    );
    this.logger.event("info", "gateway.decision", "gateway allowed request", {
      verdict: "allow",
      method: req.method,
      host: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      session_id: sessionId,
      request_id: requestId,
      connection: decision.connection.name,
    });
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(
      target,
      {
        method: req.method,
        headers: { ...decision.headers, host: target.host },
      },
      (upstreamResponse) => {
        res.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end("upstream request failed\n");
      this.logger.event("warn", "gateway.upstream_failed", error.message, {
        session_id: sessionId,
        request_id: requestId,
      });
    });
    req.pipe(upstream);
  }
  private async connect(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const sessionId = this.authenticate(req);
    if (!sessionId) {
      socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=rr\r\n\r\n",
      );
      return;
    }
    const [host, rawPort] = (req.url ?? "").split(":");
    const port = Number(rawPort || 443);
    if (!host || port !== 443) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\npolicy denied CONNECT\n");
      return;
    }
    try {
      // Deny before TLS interception when no HTTPS connection can possibly match this host and port.
      const possible = this.candidates.some(({ connection }) => {
        if (!connection.url) return false;
        const url = new URL(connection.url);
        return (
          url.protocol === "https:" &&
          url.hostname.toLowerCase() === host.toLowerCase() &&
          Number(url.port || 443) === port
        );
      });
      if (!possible)
        throw new RrError("policy denied the requested destination", 403);
      const cert = await certificateFor(this.paths, host, this.ca!);
      const key = await readFile(cert.key),
        certificate = await readFile(cert.cert);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      const tlsServer = tls.createServer(
        { key, cert: certificate },
        (secure) => {
          const inner = http.createServer(
            (innerReq, innerRes) =>
              void this.forward(
                innerReq,
                innerRes,
                new URL(`https://${host}:${port}${innerReq.url}`),
                sessionId,
              ).catch((error) => respondError(innerRes, error)),
          );
          inner.emit("connection", secure);
        },
      );
      tlsServer.emit("connection", socket);
    } catch (error) {
      this.logger.event("info", "gateway.decision", "gateway denied request", {
        verdict: "deny",
        method: "CONNECT",
        host,
        port,
        session_id: sessionId,
      });
      socket.end(
        `HTTP/1.1 ${error instanceof RrError ? error.exitCode : 502} Forbidden\r\n\r\nrequest denied\n`,
      );
    }
  }
  async stop(): Promise<void> {
    clearInterval(this.refreshTimer);
    const servers = this.servers.splice(0);
    this.sessions.clear();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }
}

async function bodyJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}
function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function respondError(res: ServerResponse, error: unknown): void {
  const status = error instanceof RrError ? error.exitCode : 500;
  res.writeHead(status >= 400 && status <= 599 ? status : 500, {
    "content-type": "text/plain",
  });
  res.end(`${error instanceof Error ? error.message : String(error)}\n`);
}
