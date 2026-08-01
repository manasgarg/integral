import http from "node:http";
import type { EffectiveConfig } from "./config.ts";
import { listConnections, type Connection } from "./connections.ts";
import type { RrPaths } from "./paths.ts";
import type { Logger } from "./logging.ts";
import {
  buildContainerSpec,
  dockerAvailable,
  dockerContainerBackend,
  freshSessionHome,
  newSessionIdentity,
  writeMcpExtension,
  writePiCredential,
  type ContainerBackend,
  type PiRuntime,
} from "./container.ts";
import { ensureCa } from "./ca.ts";
import { componentEndpoint, internalFetch } from "./http-client.ts";
import { deploymentId, readComponentState } from "./state.ts";
import { updateComponentState } from "./state.ts";
import { readText } from "./fs.ts";
import { join } from "node:path";
import { RrError } from "./errors.ts";
import type { ConversationEvent, QueuedMessage } from "./queue.ts";
import { sameSelection, type ModelSelection } from "./model-selection.ts";

export interface RunnerClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RunnerDependencies {
  containers: ContainerBackend;
  clock: RunnerClock;
  internalFetch: typeof internalFetch;
  fetch: typeof globalThis.fetch;
  ensureCa: typeof ensureCa;
  freshSessionHome: typeof freshSessionHome;
  newSessionIdentity: typeof newSessionIdentity;
  writeMcpExtension: typeof writeMcpExtension;
  writePiCredential: typeof writePiCredential;
  listen(server: http.Server, port: number, address: string): Promise<void>;
  close(server: http.Server): Promise<void>;
}

const systemClock: RunnerClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
};

const productionDependencies: RunnerDependencies = {
  containers: dockerContainerBackend,
  clock: systemClock,
  internalFetch,
  fetch: globalThis.fetch,
  ensureCa,
  freshSessionHome,
  newSessionIdentity,
  writeMcpExtension,
  writePiCredential,
  async listen(server, port, address) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, address, resolve);
    });
  },
  async close(server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  },
};

export class Runner {
  private server: http.Server | undefined;
  private pi: PiRuntime | undefined;
  private stopped = false;
  private polling: unknown;
  private busy = false;
  private idle: unknown;
  private dockerGateway = "";
  private currentMessageId: string | undefined;
  private piSelection: ModelSelection | undefined;
  private readonly dependencies: RunnerDependencies;
  constructor(
    private readonly paths: RrPaths,
    private readonly config: EffectiveConfig,
    private readonly logger: Logger,
    overrides: Partial<RunnerDependencies> = {},
  ) {
    this.dependencies = { ...productionDependencies, ...overrides };
  }
  async start(): Promise<http.Server> {
    const network = `rr-${deploymentId(this.paths)}`;
    await this.dependencies.containers.ensureNetwork(network);
    this.dockerGateway =
      await this.dependencies.containers.networkGateway(network);
    await this.ensureGatewayListener().catch(() => undefined);
    const server = http.createServer((req, res) => {
      if (req.url === "/rr/health") {
        void readComponentState(this.paths, "runner").then((state) => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              component: "runner",
              deploymentId: deploymentId(this.paths),
              status: state?.status ?? "ready",
              error: state?.error,
              session: this.pi?.spec.sessionId ?? null,
            }),
          );
        });
      } else res.writeHead(404).end();
    });
    this.server = server;
    await this.dependencies.listen(
      server,
      this.config.server.runnerPort,
      "127.0.0.1",
    );
    this.schedule(0);
    return server;
  }
  private schedule(ms = 500): void {
    if (!this.stopped)
      this.polling = this.dependencies.clock.setTimeout(
        () => void this.poll(),
        ms,
      );
  }
  private async poll(): Promise<void> {
    await this.runOnce();
    this.schedule();
  }
  async runOnce(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let item: QueuedMessage | undefined;
    try {
      const [coordinatorState, gatewayState, generationRaw] = await Promise.all(
        [
          readComponentState(this.paths, "coordinator"),
          readComponentState(this.paths, "gateway"),
          readText(join(this.paths.state, "connection-generation")),
        ],
      );
      const generation = Number(generationRaw?.trim() || "0");
      await updateComponentState(this.paths, "runner", {
        connectionGeneration: generation,
        status: "ready",
      });
      if (
        !coordinatorState ||
        !gatewayState ||
        coordinatorState.status !== "ready" ||
        gatewayState.status !== "ready" ||
        coordinatorState.fingerprint !== this.config.fingerprint ||
        gatewayState.fingerprint !== this.config.fingerprint ||
        coordinatorState.connectionGeneration !== generation ||
        gatewayState.connectionGeneration !== generation
      )
        throw new RrError(
          "component configuration or connection generations disagree",
        );
      await this.ensureGatewayListener();
      const gateway = await this.dependencies.fetch(
        new URL("/rr/health", await componentEndpoint(this.paths, "gateway")),
      );
      if (!gateway.ok) throw new RrError("gateway unavailable");
      const response = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        "/rr/internal/claim",
        { method: "POST", body: "{}" },
      );
      if (!response.ok) throw new RrError(`claim failed: ${response.status}`);
      const body = (await response.json()) as {
        message?: QueuedMessage;
        context: ConversationEvent[];
        selection?: ModelSelection | null;
      };
      const selection = body.selection ?? undefined;
      if (this.pi && !sameSelection(this.piSelection, selection))
        await this.destroyPi();
      item = body.message;
      if (!item) {
        this.armIdle();
        return;
      }
      this.currentMessageId = item.id;
      if (!selection)
        throw new RrError(
          "conversation has no selected model connection and model",
        );
      this.dependencies.clock.clearTimeout(this.idle);
      await this.ensurePi(body.context, selection);
      const answer = await this.pi!.prompt(item.text);
      const completed = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        `/rr/internal/work/${item.id}/complete`,
        { method: "POST", body: JSON.stringify({ text: answer }) },
      );
      if (!completed.ok)
        throw new RrError(`completion failed: ${completed.status}`);
      this.currentMessageId = undefined;
    } catch (error) {
      await updateComponentState(this.paths, "runner", {
        status: "degraded",
        error: error instanceof Error ? error.message : String(error),
      });
      if (item) {
        await this.dependencies
          .internalFetch(
            this.paths,
            "runner",
            "coordinator",
            `/rr/internal/work/${item.id}/release`,
            {
              method: "POST",
              body: JSON.stringify({
                reason: error instanceof Error ? error.message : String(error),
              }),
            },
          )
          .catch(() => undefined);
        this.currentMessageId = undefined;
      }
      if (
        this.pi &&
        /gateway|container|timed out|exited|rejected prompt/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        await this.destroyPi();
      const context = item
        ? {
            message_id: item.id,
            ...(this.pi ? { session_id: this.pi.spec.sessionId } : {}),
          }
        : {};
      this.logger.event(
        "warn",
        "runner.turn_failed",
        error instanceof Error ? error.message : String(error),
        context,
      );
    } finally {
      this.busy = false;
    }
  }
  private async ensureGatewayListener(): Promise<void> {
    const response = await this.dependencies.internalFetch(
      this.paths,
      "runner",
      "gateway",
      "/rr/internal/docker-listener",
      { method: "POST", body: JSON.stringify({ address: this.dockerGateway }) },
    );
    if (!response.ok)
      throw new RrError(
        `gateway Docker listener unavailable: ${response.status}`,
      );
  }
  private async ensurePi(
    context: ConversationEvent[],
    selection: ModelSelection,
  ): Promise<void> {
    if (this.pi) return;
    const resolvedImage = await this.dependencies.containers.ensureImage(
      this.config,
      selection.piVersion,
    );
    if (resolvedImage !== selection.piImage)
      throw new RrError(
        `selected Pi image ${selection.piImage} is unavailable; run /model to refresh the runtime selection`,
      );
    const all = await listConnections(this.paths),
      model = selectModel(all, selection),
      mcp = all.filter((c) => c.kind === "mcp");
    const identity = this.dependencies.newSessionIdentity(),
      ca = await this.dependencies.ensureCa(this.paths),
      home = await this.dependencies.freshSessionHome();
    await this.dependencies.writeMcpExtension(home, mcp);
    await this.dependencies.writePiCredential(home, model);
    const gatewayUrl = new URL(await componentEndpoint(this.paths, "gateway"));
    gatewayUrl.hostname = "host.rr.internal";
    const spec = buildContainerSpec({
      config: this.config,
      gatewayUrl: gatewayUrl.toString(),
      gatewayAddress: this.dockerGateway,
      caCert: ca.cert,
      caBundle: ca.bundle,
      sessionHome: home,
      ...identity,
      model,
      selectedModel: selection.model,
      image: selection.piImage,
      mcp,
    });
    if (context.length)
      spec.args.push("--append-system-prompt", renderContext(context));
    await this.dependencies.internalFetch(
      this.paths,
      "runner",
      "gateway",
      "/rr/internal/session",
      {
        method: "POST",
        body: JSON.stringify({
          token: identity.sessionToken,
          sessionId: identity.sessionId,
        }),
      },
    );
    const pi = this.dependencies.containers.createPi(
      spec,
      this.config,
      `rr-${deploymentId(this.paths)}`,
      (line) =>
        this.logger.event("debug", "pi.stderr", line, {
          session_id: identity.sessionId,
        }),
    );
    try {
      await pi.start();
      this.pi = pi;
      this.piSelection = { ...selection };
      await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        "/rr/internal/session",
        {
          method: "POST",
          body: JSON.stringify({
            sessionId: identity.sessionId,
            state: "started",
          }),
        },
      );
    } catch (error) {
      await this.revoke(identity.sessionToken);
      await pi.stop();
      throw error;
    }
  }
  private armIdle(): void {
    if (!this.pi || this.idle) return;
    this.idle = this.dependencies.clock.setTimeout(
      () => void this.destroyPi(),
      this.config.runner.idleTimeoutSeconds * 1000,
    );
  }
  private async revoke(token: string): Promise<void> {
    await this.dependencies
      .internalFetch(this.paths, "runner", "gateway", "/rr/internal/session", {
        method: "DELETE",
        body: JSON.stringify({ token }),
      })
      .catch(() => undefined);
  }
  private async destroyPi(): Promise<void> {
    this.dependencies.clock.clearTimeout(this.idle);
    this.idle = undefined;
    const pi = this.pi;
    this.pi = undefined;
    this.piSelection = undefined;
    if (pi) {
      await this.revoke(pi.spec.sessionToken);
      await pi.stop();
      await this.dependencies
        .internalFetch(
          this.paths,
          "runner",
          "coordinator",
          "/rr/internal/session",
          {
            method: "POST",
            body: JSON.stringify({
              sessionId: pi.spec.sessionId,
              state: "ended",
            }),
          },
        )
        .catch(() => undefined);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.dependencies.clock.clearTimeout(this.polling);
    const messageId = this.currentMessageId;
    this.currentMessageId = undefined;
    if (messageId)
      await this.dependencies
        .internalFetch(
          this.paths,
          "runner",
          "coordinator",
          `/rr/internal/work/${messageId}/release`,
          {
            method: "POST",
            body: JSON.stringify({ reason: "runner stopped" }),
          },
        )
        .catch(() => undefined);
    await this.destroyPi();
    const server = this.server;
    if (server) await this.dependencies.close(server);
  }
}

export async function validateRunnerHost(paths: RrPaths): Promise<void> {
  const connections = await listConnections(paths);
  requireActiveModelConnection(connections);
  if (!dockerAvailable()) throw new RrError("Docker daemon is unavailable");
}

export function requireActiveModelConnection(connections: Connection[]): void {
  if (
    !connections.some(
      (connection) =>
        connection.kind === "model" &&
        "state" in connection &&
        connection.state === "active",
    )
  )
    throw new RrError("no active model connection; run rr connection add");
}

export function selectModel(
  connections: Connection[],
  selection: ModelSelection,
): Connection {
  const active = connections.filter(
    (c) => c.kind === "model" && "state" in c && c.state === "active",
  );
  const selected = active.find(
    (connection) =>
      connection.name === selection.connection &&
      connection.provider === selection.provider,
  );
  if (!selected)
    throw new RrError(
      `selected model connection ${selection.connection} is absent, disabled, or no longer matches provider ${selection.provider}`,
    );
  return selected;
}
export function renderContext(events: ConversationEvent[]): string {
  return `Continue this durable conversation. Prior messages:\n${events
    .filter((e) => e.text)
    .map((e) => `${e.type}: ${e.text}`)
    .join("\n")}`;
}
