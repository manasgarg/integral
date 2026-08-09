import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Connection } from "./connections.ts";
import {
  connectionBoundaries,
  credentialFor,
  loadConnections,
} from "./connections.ts";
import type { IntegralPaths } from "./paths.ts";
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
import { IntegralError } from "./errors.ts";
import type { Logger } from "./logging.ts";
import { oauthAccess, refreshOAuth } from "./oauth.ts";
import { acquireLock, atomicWrite } from "./fs.ts";
import { readText } from "./fs.ts";
import { join } from "node:path";
import {
  nodeHttpServerRuntime,
  nodeIntervalRuntime,
  type HttpServerRuntime,
  type IntervalRuntime,
} from "./runtime.ts";
import { executeEmail, parseEmailOperation } from "./email.ts";
import { internalFetch } from "./http-client.ts";
import { callRemoteMcp } from "./mcp.ts";
import { readJsonObject, readRequestBody, writeJson } from "./http-server.ts";
import {
  createResource,
  listRepositoryRecovery,
  listResourceRecords,
  listStoreSnapshots,
  refreshResource,
  repositoryBundlePush,
  resourceForId,
  restoreResource,
  restoreStoreSnapshot,
  sessionHasResource,
  softDeleteResource,
  type ResourceKind,
  type ResourceRecord,
} from "./resources.ts";
import {
  IMAGE_RECIPE_ID,
  IMAGE_RECIPE_MOUNT,
  IMAGE_RECIPE_NAME,
  ensureImageRecipeRepository,
} from "./image-recipe.ts";

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

export function allowsConnect(
  candidates: CredentialedConnection[],
  host: string,
  port: number,
): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return candidates.some(({ connection }) => {
    return connectionBoundaries(connection).some(
      (url) =>
        url.protocol === "https:" &&
        url.hostname.toLowerCase() === host.toLowerCase() &&
        Number(url.port || 443) === port,
    );
  });
}

export class Gateway {
  readonly sessions = new Map<string, string>();
  readonly sessionRunIds = new Map<string, string>();
  readonly taskSessions = new Map<
    string,
    { executionId: string; attemptId: string }
  >();
  private servers: http.Server[] = [];
  private ca?: CaFiles;
  private token = "";
  private candidates: CredentialedConnection[] = [];
  private refreshTimer: unknown;
  private lastConnectionHash: string | undefined;
  private lastGeneration = 0;
  private sawInvalidConnections = false;
  private readonly resourceLocks = new Map<
    string,
    {
      sessionId: string;
      resourceId: string;
      name: string;
      release(): Promise<void>;
    }
  >();
  private readonly dependencies: GatewayDependencies;
  constructor(
    private readonly paths: IntegralPaths,
    private readonly config: EffectiveConfig,
    private readonly logger: Logger,
    overrides: Partial<GatewayDependencies> = {},
  ) {
    this.dependencies = { ...productionDependencies, ...overrides };
  }
  async start(): Promise<http.Server> {
    this.ca = await this.dependencies.ensureCa(this.paths);
    this.token = await componentIdentity(this.paths);
    await this.reload(true);
    const server = this.makeServer();
    this.servers.push(server);
    await this.dependencies.servers.listen(
      server,
      this.config.server.gatewayPort,
      "127.0.0.1",
    );
    this.refreshTimer = this.dependencies.intervals.setInterval(
      () => void this.reload(false),
      500,
    );
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
      throw new IntegralError(loaded.errors.join("\n"));
    const credentialErrors: string[] = [];
    this.candidates = await Promise.all(
      loaded.connections.map(async (connection) => {
        const raw = await credentialFor(this.paths, connection.name);
        let credential = raw,
          injectedHeaders: Record<string, string> | undefined;
        if (raw && oauthAccess(raw))
          try {
            const refreshed = await this.dependencies.refreshOAuth(
              this.paths,
              connection,
              raw,
            );
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
      await atomicWrite(
        join(this.paths.state, "session-generation"),
        `${generation}\n`,
      );
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
    if (req.url === "/integral/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(await gatewayHealth(this.paths)));
      return;
    }
    if (req.url === "/integral/internal/session" && req.method === "POST") {
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
        sessionId = stringValue(body.sessionId),
        runId = stringValue(body.runId),
        executionId = stringValue(body.executionId),
        attemptId = stringValue(body.attemptId);
      if (!token || !sessionId) {
        res.writeHead(400).end("invalid session\n");
        return;
      }
      if (Boolean(executionId) !== Boolean(attemptId)) {
        res.writeHead(400).end("incomplete task session identity\n");
        return;
      }
      this.sessions.set(token, sessionId);
      if (runId) this.sessionRunIds.set(sessionId, runId);
      if (executionId && attemptId)
        this.taskSessions.set(sessionId, { executionId, attemptId });
      res.writeHead(204).end();
      return;
    }
    if (
      req.url === "/integral/internal/docker-listener" &&
      req.method === "POST"
    ) {
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
        await this.dependencies.servers.listen(
          dockerServer,
          this.config.server.gatewayPort,
          address,
        );
        this.servers.push(dockerServer);
      }
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/integral/internal/session" && req.method === "DELETE") {
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
        sessionId = this.sessions.get(token);
      this.sessions.delete(token);
      if (sessionId) {
        this.sessionRunIds.delete(sessionId);
        this.taskSessions.delete(sessionId);
        await this.releaseSessionLocks(sessionId);
      }
      res.writeHead(204).end();
      return;
    }
    const sessionId = this.authenticate(req);
    if (!sessionId) {
      res
        .writeHead(407, { "proxy-authenticate": "Basic realm=integral" })
        .end("proxy authentication required\n");
      return;
    }
    if (req.url === "/integral/task-outcome" && req.method === "POST") {
      try {
        const task = this.taskSessions.get(sessionId);
        if (!task)
          throw new IntegralError(
            "task outcome is unavailable outside an active task attempt",
            403,
          );
        const body = await bodyJson(req, 110_000),
          outcome = stringValue(body.outcome),
          message = stringValue(body.message);
        if (outcome !== "complete" && outcome !== "failed")
          throw new IntegralError("invalid task outcome declaration", 400);
        const upstream = await this.dependencies.internalFetch(
          this.paths,
          "gateway",
          "coordinator",
          `/integral/internal/tasks/${encodeURIComponent(task.executionId)}/declare`,
          {
            method: "POST",
            body: JSON.stringify({
              attemptId: task.attemptId,
              outcome,
              message,
            }),
          },
        );
        const responseBody = await upstream.text();
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(responseBody);
      } catch (error) {
        respondError(res, error);
      }
      return;
    }
    if (req.url === "/integral/email" && req.method === "POST") {
      const requestId = randomUUID();
      let name = "",
        operation = "unknown",
        provider = "unknown";
      try {
        const body = await bodyJson(req, 500_000);
        name = stringValue(body.connection);
        operation = stringValue(body.operation, "unknown");
        const candidate = this.candidates.find(
          ({ connection }) =>
            connection.kind === "email" && connection.name === name,
        );
        if (!candidate)
          throw new IntegralError(`email connection not found: ${name}`, 404);
        provider = candidate.connection.provider ?? "unknown";
        const result = await this.dependencies.executeEmail(
          candidate.connection,
          candidate.credential,
          parseEmailOperation(body),
        );
        this.logger.event(
          "info",
          "gateway.email",
          "email operation completed",
          {
            verdict: "allow",
            operation,
            connection: name,
            provider,
            session_id: sessionId,
            request_id: requestId,
          },
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        this.logger.event(
          "warn",
          "gateway.email_failed",
          error instanceof Error ? error.message : String(error),
          {
            verdict: "deny",
            operation,
            connection: name || "unknown",
            provider,
            session_id: sessionId,
            request_id: requestId,
          },
        );
        respondError(res, error);
      }
      return;
    }
    if (req.url === "/integral/mcp" && req.method === "POST") {
      try {
        const body = await bodyJson(req, 1_000_000),
          name = stringValue(body.connection),
          tool = stringValue(body.tool),
          args =
            body.arguments &&
            typeof body.arguments === "object" &&
            !Array.isArray(body.arguments)
              ? (body.arguments as Record<string, unknown>)
              : {};
        const candidate = this.candidates.find(
          ({ connection }) =>
            connection.kind === "mcp" && connection.name === name,
        );
        if (!candidate)
          throw new IntegralError(`MCP connection not found: ${name}`, 404);
        if (!tool) throw new IntegralError("MCP tool name is required", 400);
        if (candidate.connection.transport === "stdio") {
          const upstream = await this.dependencies.internalFetch(
            this.paths,
            "gateway",
            "runner",
            "/integral/internal/mcp",
            {
              method: "POST",
              body: JSON.stringify({
                sessionId,
                connection: name,
                tool,
                arguments: args,
              }),
            },
          );
          res.writeHead(upstream.status, {
            "content-type":
              upstream.headers.get("content-type") ?? "application/json",
          });
          res.end(await upstream.text());
          return;
        }
        const result = await this.dependencies.callRemoteMcp(
          candidate.connection,
          candidate.credential,
          tool,
          args,
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        respondError(res, error);
      }
      return;
    }
    if (
      req.url?.startsWith("/integral/control/schedules") ||
      req.url === "/integral/control/container-packages" ||
      req.url === "/integral/control/image-rebuild" ||
      req.url?.startsWith("/integral/control/resources/")
    ) {
      try {
        await this.control(
          req,
          res,
          new URL(req.url, "http://integral.control"),
          sessionId,
        );
      } catch (error) {
        respondError(res, error);
      }
      return;
    }
    let target: URL | undefined;
    try {
      target = new URL(req.url!);
      if (
        target.protocol === "http:" &&
        target.hostname === "integral.control" &&
        !target.port
      )
        await this.control(req, res, target, sessionId);
      else await this.forward(req, res, target, sessionId);
    } catch (error) {
      this.logger.event("info", "gateway.decision", "gateway denied request", {
        verdict:
          error instanceof IntegralError && error.exitCode === 403
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
  private async control(
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    sessionId: string,
  ): Promise<void> {
    if (target.pathname === "/integral/control/container-packages") {
      await this.containerPackageControl(req, res, sessionId);
      return;
    }
    if (target.pathname === "/integral/control/image-rebuild") {
      if ((req.method ?? "POST") !== "POST")
        throw new IntegralError("unsupported image rebuild operation", 405);
      await this.imageApprovalControl(res, sessionId, { operation: "rebuild" });
      return;
    }
    if (target.pathname.startsWith("/integral/control/resources/")) {
      await this.resourceControl(req, res, target, sessionId);
      return;
    }
    if (!target.pathname.startsWith("/integral/control/schedules"))
      throw new IntegralError("unknown integral control endpoint", 404);
    const schedulerPath = target.pathname.replace(
        "/integral/control",
        "/integral",
      ),
      body = await bodyJson(req);
    const upstream = await this.scheduleControl(
      sessionId,
      req.method ?? "GET",
      `${schedulerPath}${target.search}`,
      body,
    );
    const responseBody = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(responseBody);
  }
  private async containerPackageControl(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "POST")
      throw new IntegralError("unsupported package operation", 405);
    const body = method === "POST" ? await bodyJson(req) : {};
    if (method === "POST") {
      delete body.actor;
      delete body.originSessionId;
      delete body.originRunId;
      body.originSessionId = sessionId;
      const runId = this.sessionRunIds.get(sessionId);
      if (runId) body.originRunId = runId;
    }
    const abort = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const upstream = await this.dependencies.internalFetch(
        this.paths,
        "gateway",
        "coordinator",
        "/integral/internal/container-packages",
        {
          method,
          signal: abort.signal,
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        },
      ),
      responseBody = await upstream.text();
    if (method === "POST" && upstream.ok)
      this.logger.event(
        "info",
        "gateway.container_packages",
        "container package request allowed",
        {
          verdict: "allow",
          operation: stringValue(body.operation),
          session_id: sessionId,
          request_id: randomUUID(),
        },
      );
    res.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(responseBody);
  }
  private async resourceControl(
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    sessionId: string,
  ): Promise<void> {
    const parts = target.pathname
        .slice("/integral/control/resources/".length)
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent),
      collection = parts[0],
      kind: ResourceKind = collection === "repos" ? "host-repo" : "host-store";
    if (collection !== "repos" && collection !== "stores")
      throw new IntegralError("unknown resource collection", 404);
    const method = req.method ?? "GET";
    if (parts.length === 1 && method === "GET") {
      const records = await Promise.all(
        (await listResourceRecords(this.paths))
          .filter((value) => value.kind === kind)
          .map((value) => refreshResource(this.paths, value)),
      );
      const inventory: Array<Record<string, unknown>> = await Promise.all(
        records.map(async (value) => ({
          ...publicResource(value),
          ...(kind === "host-store"
            ? {
                snapshots: (await listStoreSnapshots(this.paths, value.id))
                  .length,
              }
            : {
                recoveryArtifacts: await listRepositoryRecovery(
                  this.paths,
                  value.id,
                ),
              }),
        })),
      );
      if (kind === "host-repo") {
        const head = await ensureImageRecipeRepository(this.paths);
        inventory.unshift({
          id: IMAGE_RECIPE_ID,
          name: IMAGE_RECIPE_NAME,
          kind: "host-repo",
          state: "active",
          revision: 0,
          branch: "main",
          mount: IMAGE_RECIPE_MOUNT,
          writePolicy: "approval-required",
          head,
          recoveryArtifacts: await listRepositoryRecovery(
            this.paths,
            IMAGE_RECIPE_ID,
          ),
        });
      }
      respondJson(res, inventory);
      return;
    }
    if (parts.length === 1 && method === "POST") {
      const body = await bodyJson(req),
        name = stringValue(body.name),
        mount = stringValue(body.mount);
      if (!name || !mount)
        throw new IntegralError("name and mount are required", 400);
      const value = await createResource(
        this.paths,
        kind,
        name,
        mount,
        this.config,
      );
      this.logger.event(
        "info",
        "gateway.resource_created",
        "resource created",
        {
          resource_id: value.id,
          session_id: sessionId,
          kind,
        },
      );
      respondJson(res, publicResource(value), 201);
      return;
    }
    const id = parts[1];
    if (kind === "host-repo" && id === IMAGE_RECIPE_ID && parts[2] === "git") {
      await ensureImageRecipeRepository(this.paths);
      if (
        method === "GET" &&
        parts[3] === "info" &&
        parts[4] === "refs" &&
        target.searchParams.get("service") === "git-upload-pack"
      ) {
        const advertised = await gitUploadPack(
            this.paths.imageRecipe,
            undefined,
            true,
          ),
          prefix = Buffer.from("001e# service=git-upload-pack\n0000");
        res.writeHead(200, {
          "content-type": "application/x-git-upload-pack-advertisement",
          "cache-control": "no-cache",
        });
        res.end(Buffer.concat([prefix, advertised]));
        return;
      }
      if (method === "POST" && parts[3] === "git-upload-pack") {
        const request = await readRequestBody(req, 16 * 1024 * 1024),
          response = await gitUploadPack(
            this.paths.imageRecipe,
            request,
            false,
          );
        res.writeHead(200, {
          "content-type": "application/x-git-upload-pack-result",
          "cache-control": "no-cache",
        });
        res.end(response);
        return;
      }
      throw new IntegralError("unknown image recipe Git operation", 404);
    }
    if (
      kind === "host-repo" &&
      id === IMAGE_RECIPE_ID &&
      parts[2] === "push" &&
      method === "POST"
    ) {
      const body = await bodyJson(req, 45 * 1024 * 1024);
      await this.imageApprovalControl(res, sessionId, {
        operation: "proposal",
        proposed: stringValue(body.proposed),
        bundle: stringValue(body.bundle),
      });
      return;
    }
    const resource = id ? await resourceForId(this.paths, id) : undefined;
    if (!resource || resource.kind !== kind)
      throw new IntegralError("resource not found", 404);
    if (kind === "host-store" && parts[2] === "locks" && parts.length === 4) {
      if (!(await sessionHasResource(this.paths, resource.id, sessionId)))
        throw new IntegralError("store is not mounted in this session", 403);
      const current = await refreshResource(this.paths, resource);
      if (current.state !== "active")
        throw new IntegralError(
          current.state === "soft-deleted"
            ? "resource_soft_deleted"
            : "resource_unavailable",
          409,
        );
      const name = parts[3]!;
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name))
        throw new IntegralError("invalid store lock name", 400);
      if (method === "POST") {
        const release = await acquireResourceAdvisoryLock(
            this.paths,
            resource.id,
            name,
            req,
          ),
          lease = randomUUID();
        this.resourceLocks.set(lease, {
          sessionId,
          resourceId: resource.id,
          name,
          release,
        });
        respondJson(res, { lease });
        return;
      }
      if (method === "DELETE") {
        const body = await bodyJson(req),
          lease = stringValue(body.lease),
          held = this.resourceLocks.get(lease);
        if (
          !held ||
          held.sessionId !== sessionId ||
          held.resourceId !== resource.id ||
          held.name !== name
        )
          throw new IntegralError("store lock lease not found", 404);
        this.resourceLocks.delete(lease);
        await held.release();
        res.writeHead(204).end();
        return;
      }
    }
    if (kind === "host-repo" && parts[2] === "git") {
      if (!(await sessionHasResource(this.paths, resource.id, sessionId)))
        throw new IntegralError(
          "repository is not mounted in this session",
          403,
        );
      const active = await refreshResource(this.paths, resource);
      if (active.state !== "active")
        throw new IntegralError("resource_unavailable", 409);
      if (
        method === "GET" &&
        parts[3] === "info" &&
        parts[4] === "refs" &&
        target.searchParams.get("service") === "git-upload-pack"
      ) {
        const advertised = await gitUploadPack(active.path, undefined, true),
          prefix = Buffer.from("001e# service=git-upload-pack\n0000");
        res.writeHead(200, {
          "content-type": "application/x-git-upload-pack-advertisement",
          "cache-control": "no-cache",
        });
        res.end(Buffer.concat([prefix, advertised]));
        return;
      }
      if (method === "POST" && parts[3] === "git-upload-pack") {
        const request = await readRequestBody(req, 16 * 1024 * 1024),
          response = await gitUploadPack(active.path, request, false);
        res.writeHead(200, {
          "content-type": "application/x-git-upload-pack-result",
          "cache-control": "no-cache",
        });
        res.end(response);
        return;
      }
      throw new IntegralError("unknown Git repository operation", 404);
    }
    if (parts.length === 2 && method === "DELETE") {
      const body = await bodyJson(req),
        revision = integerValue(body.expectedRevision);
      const value = await softDeleteResource(
        this.paths,
        resource.connection,
        revision,
        `pi:${sessionId}`,
      );
      respondJson(res, publicResource(value));
      return;
    }
    if (parts[2] === "restore" && parts.length === 3 && method === "POST") {
      const body = await bodyJson(req),
        value = await restoreResource(
          this.paths,
          resource.connection,
          integerValue(body.expectedRevision),
          stringValue(body.mount),
        );
      respondJson(res, publicResource(value));
      return;
    }
    if (kind === "host-repo" && parts[2] === "push" && method === "POST") {
      const body = await bodyJson(
          req,
          Math.ceil((this.config.repositories.maxRepoBytes * 4) / 3) + 10_000,
        ),
        encoded = stringValue(body.bundle),
        proposed = stringValue(body.proposed);
      const value = await repositoryBundlePush(
        this.paths,
        this.config,
        resource.id,
        Buffer.from(encoded, "base64"),
        proposed,
      );
      respondJson(res, value);
      return;
    }
    if (kind === "host-store" && parts[2] === "snapshots") {
      if (parts.length === 3 && method === "GET") {
        respondJson(res, await listStoreSnapshots(this.paths, resource.id));
        return;
      }
      if (parts.length === 5 && parts[4] === "restore" && method === "POST") {
        const body = await bodyJson(req),
          value = await restoreStoreSnapshot(
            this.paths,
            this.config,
            resource.id,
            parts[3]!,
            integerValue(body.expectedRevision),
          );
        respondJson(res, publicResource(value));
        return;
      }
    }
    throw new IntegralError("unknown resource operation", 404);
  }

  private async imageApprovalControl(
    res: ServerResponse,
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    delete body.originSessionId;
    delete body.originRunId;
    body.originSessionId = sessionId;
    const runId = this.sessionRunIds.get(sessionId);
    if (runId) body.originRunId = runId;
    const abort = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const upstream = await this.dependencies.internalFetch(
        this.paths,
        "gateway",
        "coordinator",
        "/integral/internal/image-recipe",
        {
          method: "POST",
          signal: abort.signal,
          body: JSON.stringify(body),
        },
      ),
      responseBody = await upstream.text();
    if (upstream.ok)
      this.logger.event(
        "info",
        "gateway.image_recipe",
        "image recipe request resolved",
        {
          operation: stringValue(body.operation),
          session_id: sessionId,
          request_id: randomUUID(),
        },
      );
    res.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(responseBody);
  }
  async scheduleControl(
    sessionId: string,
    method: string,
    schedulerPath: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    if (method !== "GET") {
      body.actor = `pi:${sessionId}`;
      delete body.profile;
    }
    if (method === "POST" && schedulerPath === "/integral/schedules") {
      const snapshot = await this.dependencies.internalFetch(
        this.paths,
        "gateway",
        "coordinator",
        "/integral/snapshot",
      );
      if (!snapshot.ok)
        throw new IntegralError("conversation model is unavailable", 409);
      const data = (await snapshot.json()) as { modelSelection?: unknown };
      if (!data.modelSelection)
        throw new IntegralError(
          "select a model before creating a schedule",
          409,
        );
      body.profile = data.modelSelection;
    }
    return this.dependencies.internalFetch(
      this.paths,
      "gateway",
      "scheduler",
      schedulerPath,
      {
        method,
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      },
    );
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
    const upstream = this.dependencies.request(
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
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=integral\r\n\r\n",
      );
      return;
    }
    const [host, rawPort] = (req.url ?? "").split(":");
    const port = Number(rawPort || 443);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\npolicy denied CONNECT\n");
      return;
    }
    try {
      // Deny before TLS interception when no HTTPS connection can possibly match this host and port.
      const possible = allowsConnect(this.candidates, host, port);
      if (!possible)
        throw new IntegralError("policy denied the requested destination", 403);
      const cert = await this.dependencies.certificateFor(
        this.paths,
        host,
        this.ca!,
      );
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
        `HTTP/1.1 ${error instanceof IntegralError ? error.exitCode : 502} Forbidden\r\n\r\nrequest denied\n`,
      );
    }
  }
  async stop(): Promise<void> {
    this.dependencies.intervals.clearInterval(this.refreshTimer);
    const servers = this.servers.splice(0);
    const locks = [...this.resourceLocks.values()];
    this.resourceLocks.clear();
    this.sessions.clear();
    this.sessionRunIds.clear();
    this.taskSessions.clear();
    await Promise.all([
      ...locks.map((lock) => lock.release().catch(() => undefined)),
      ...servers.map((server) => this.dependencies.servers.close(server)),
    ]);
  }
  private async releaseSessionLocks(sessionId: string): Promise<void> {
    const held = [...this.resourceLocks.entries()].filter(
      ([, value]) => value.sessionId === sessionId,
    );
    for (const [lease, value] of held) {
      this.resourceLocks.delete(lease);
      await value.release().catch(() => undefined);
    }
  }
}

export interface GatewayDependencies {
  servers: HttpServerRuntime;
  intervals: IntervalRuntime;
  ensureCa: typeof ensureCa;
  certificateFor: typeof certificateFor;
  refreshOAuth: typeof refreshOAuth;
  executeEmail: typeof executeEmail;
  callRemoteMcp: typeof callRemoteMcp;
  request(
    target: URL,
    options: http.RequestOptions,
    response: (message: http.IncomingMessage) => void,
  ): http.ClientRequest;
  internalFetch: typeof internalFetch;
}

const productionDependencies: GatewayDependencies = {
  servers: nodeHttpServerRuntime,
  intervals: nodeIntervalRuntime,
  ensureCa,
  certificateFor,
  refreshOAuth,
  executeEmail,
  callRemoteMcp,
  internalFetch,
  request(target, options, response) {
    return (target.protocol === "https:" ? https : http).request(
      target,
      options,
      response,
    );
  },
};

export async function gatewayHealth(paths: IntegralPaths): Promise<{
  component: "gateway";
  deploymentId: string;
  status: "ready" | "degraded";
  error?: string;
}> {
  const state = await readComponentState(paths, "gateway");
  return {
    component: "gateway",
    deploymentId: deploymentId(paths),
    status: state?.status ?? "ready",
    ...(state?.error ? { error: state.error } : {}),
  };
}

async function bodyJson(
  req: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  return await readJsonObject(req, { maxBytes, invalidAsEmpty: true });
}
async function gitUploadPack(
  gitDir: string,
  input: Buffer | undefined,
  advertise: boolean,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
        "git",
        [
          "upload-pack",
          "--stateless-rpc",
          ...(advertise ? ["--advertise-refs"] : []),
          gitDir,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_PROTOCOL: "version=1",
          },
        },
      ),
      output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(output));
      else
        reject(
          new IntegralError(
            Buffer.concat(errors).toString("utf8").trim() ||
              "Git upload failed",
          ),
        );
    });
    child.stdin.end(input);
  });
}
async function acquireResourceAdvisoryLock(
  paths: IntegralPaths,
  resourceId: string,
  name: string,
  req: IncomingMessage,
): Promise<() => Promise<void>> {
  const digest = createHash("sha256")
      .update(`${resourceId}\0${name}`)
      .digest("hex"),
    path = join(paths.storeLocks, `advisory-${digest}.lock`);
  for (;;) {
    if (req.destroyed)
      throw new IntegralError("store lock request was cancelled", 499);
    try {
      return await acquireLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function integerValue(value: unknown): number {
  if (!Number.isInteger(value))
    throw new IntegralError("expectedRevision must be an integer", 400);
  return value as number;
}
function publicResource(value: ResourceRecord): Record<string, unknown> {
  return {
    id: value.id,
    name: value.connection,
    kind: value.kind,
    state: value.state,
    revision: value.revision,
    writePolicy: value.writePolicy ?? "direct",
    mount: value.mount,
    ...(value.branch ? { branch: value.branch } : {}),
    ...(value.availabilityReason
      ? { availabilityReason: value.availabilityReason }
      : {}),
  };
}
function respondJson(res: ServerResponse, value: unknown, status = 200): void {
  writeJson(res, status, value, false);
}
function respondError(res: ServerResponse, error: unknown): void {
  const status = error instanceof IntegralError ? error.exitCode : 500;
  res.writeHead(status >= 400 && status <= 599 ? status : 500, {
    "content-type": "text/plain",
  });
  res.end(`${error instanceof Error ? error.message : String(error)}\n`);
}
