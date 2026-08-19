import http from "node:http";
import type { EffectiveConfig } from "./config.ts";
import {
  credentialFor,
  clearConnectionDegraded,
  listConnections,
  markConnectionDegraded,
  type Connection,
} from "./connections.ts";
import type { IntegralPaths } from "./paths.ts";
import type { Logger } from "./logging.ts";
import {
  buildContainerSpec,
  dockerAvailable,
  dockerContainerBackend,
  freshSessionHome,
  newSessionIdentity,
  writeMcpExtension,
  writeEmailExtension,
  writeTaskExtension,
  writeResourceExtension,
  writePiCredential,
  type ContainerBackend,
  type McpSidecarSpec,
  type PiRuntime,
  type TaskRuntime,
} from "./container.ts";
import {
  cleanupResourceProjection,
  ensurePiProfileRepository,
  prepareResourceProjection,
  type ResourceProjection,
} from "./resources.ts";
import { ensureCa } from "./ca.ts";
import { componentEndpoint, internalFetch } from "./http-client.ts";
import {
  componentIdentity,
  deploymentId,
  readComponentState,
  verifyInternal,
} from "./state.ts";
import { updateComponentState } from "./state.ts";
import { readText } from "./fs.ts";
import { join } from "node:path";
import { IntegralError } from "./errors.ts";
import { oauthAccess } from "./oauth.ts";
import {
  discoverRemoteMcp,
  McpCatalogRegistry,
  type McpCatalog,
} from "./mcp.ts";
import type {
  ApprovalContinuation,
  ConversationEvent,
  QueuedMessage,
} from "./queue.ts";
import { sameSelection, type ModelSelection } from "./model-selection.ts";
import type { ScheduledTask } from "./task-queue.ts";
import { rm } from "node:fs/promises";
import {
  RunStore,
  type FinalizeRunOptions,
  type RunRecorder,
  type RunTermination,
} from "./run-store.ts";
import { readJsonObject } from "./http-server.ts";
import { McpSidecarManager } from "./runner/mcp-sidecars.ts";

export interface RunnerClock {
  setTimeout(
    callback: () => void | Promise<void>,
    milliseconds: number,
  ): unknown;
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
  discoverRemoteMcp: typeof discoverRemoteMcp;
  writeEmailExtension: typeof writeEmailExtension;
  writeTaskExtension: typeof writeTaskExtension;
  writeResourceExtension: typeof writeResourceExtension;
  ensurePiProfileRepository: typeof ensurePiProfileRepository;
  prepareResourceProjection: typeof prepareResourceProjection;
  cleanupResourceProjection: typeof cleanupResourceProjection;
  writePiCredential: typeof writePiCredential;
  now(): number;
  listen(server: http.Server, port: number, address: string): Promise<void>;
  close(server: http.Server): Promise<void>;
}

const systemClock: RunnerClock = {
  setTimeout: (callback, milliseconds) =>
    setTimeout(() => void callback(), milliseconds),
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
  discoverRemoteMcp,
  writeEmailExtension,
  writeTaskExtension,
  writeResourceExtension,
  ensurePiProfileRepository,
  prepareResourceProjection,
  cleanupResourceProjection,
  writePiCredential,
  now: Date.now,
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

async function recordResourceProjection(
  recorder: RunRecorder,
  projection: ResourceProjection,
): Promise<void> {
  await recorder.event("host", "resource-projection", {
    repositories: projection.repositories.map(({ resource, initialHead }) => ({
      name: resource.connection,
      mount: resource.mount,
      commit: initialHead,
    })),
  });
}

export class Runner {
  private server: http.Server | undefined;
  private pi: PiRuntime | undefined;
  private stopped = false;
  private polling: unknown;
  private busy = false;
  private taskBusy = false;
  private idle: unknown;
  private dockerGateway = "";
  private token = "";
  private readonly mcpSidecars: McpSidecarManager;
  private readonly mcpCatalogs: McpCatalogRegistry;
  private piMcpCatalogs = new Map<string, string>();
  private currentMessageId: string | undefined;
  private currentConversationId: string | undefined;
  private piConversationId: string | undefined;
  private steeredMessageIds: string[] = [];
  private currentTask:
    { id: string; claimId: string; attemptId?: string } | undefined;
  private activeTaskRuntime: TaskRuntime | undefined;
  private taskRun: RunRecorder | undefined;
  private taskHistoryView: string | undefined;
  private taskResources: ResourceProjection | undefined;
  private piSelection: ModelSelection | undefined;
  private piSessionGeneration: number | undefined;
  private piRun: RunRecorder | undefined;
  private piHistoryView: string | undefined;
  private piResources: ResourceProjection | undefined;
  private piTurnCount = 0;
  private readonly runs: RunStore;
  private readonly dependencies: RunnerDependencies;
  constructor(
    private readonly paths: IntegralPaths,
    private readonly config: EffectiveConfig,
    private readonly logger: Logger,
    overrides: Partial<RunnerDependencies> = {},
  ) {
    this.dependencies = { ...productionDependencies, ...overrides };
    this.runs = new RunStore(paths, () => this.dependencies.now());
    this.mcpCatalogs = new McpCatalogRegistry(
      this.dependencies.discoverRemoteMcp,
      () => this.dependencies.now(),
      0,
    );
    this.mcpSidecars = new McpSidecarManager(
      this.dependencies.containers,
      config,
      `integral-${deploymentId(paths)}`,
      logger,
      this.dependencies.writeMcpExtension,
      async (connection, healthy) => {
        if (healthy) await clearConnectionDegraded(this.paths, connection);
        else await markConnectionDegraded(this.paths, connection, "sidecar");
      },
    );
  }
  async start(): Promise<http.Server> {
    await this.dependencies.ensurePiProfileRepository(this.paths, this.config);
    await this.runs.initialize();
    this.token = await componentIdentity(this.paths);
    const network = `integral-${deploymentId(this.paths)}`;
    await this.dependencies.containers.ensureNetwork(network);
    this.dockerGateway =
      await this.dependencies.containers.networkGateway(network);
    await this.ensureGatewayListener().catch(() => undefined);
    const server = http.createServer((req, res) => {
      if (req.url === "/integral/health") {
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
      } else if (
        req.url === "/integral/internal/mcp" &&
        req.method === "POST"
      ) {
        void this.routeMcp(req, res);
      } else if (
        req.url === "/integral/internal/steer" &&
        req.method === "POST"
      ) {
        void this.routeSteer(req, res);
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
  private async routeSteer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (
        !verifyInternal(
          req.headers,
          "coordinator",
          this.token,
          deploymentId(this.paths),
        )
      ) {
        res.writeHead(401).end("unauthorized\n");
        return;
      }
      const body = await runnerBodyJson(req),
        conversationId =
          typeof body.conversationId === "string" ? body.conversationId : "",
        messageId = typeof body.messageId === "string" ? body.messageId : "",
        text = typeof body.text === "string" ? body.text : "";
      if (
        !this.busy ||
        !this.pi ||
        !this.pi.steer ||
        this.currentConversationId !== conversationId ||
        !messageId ||
        !text.trim()
      ) {
        res.writeHead(409).end("turn is no longer steerable\n");
        return;
      }
      await this.pi.steer(text);
      this.steeredMessageIds.push(messageId);
      await this.piRun?.input(text, "steering", { messageId });
      res.writeHead(204).end();
    } catch (error) {
      res
        .writeHead(409)
        .end(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  private async routeMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (
        !verifyInternal(
          req.headers,
          "gateway",
          this.token,
          deploymentId(this.paths),
        )
      ) {
        res.writeHead(401).end("unauthorized\n");
        return;
      }
      const body = await runnerBodyJson(req),
        sessionId = typeof body.sessionId === "string" ? body.sessionId : "",
        connection = typeof body.connection === "string" ? body.connection : "",
        tool = typeof body.tool === "string" ? body.tool : "",
        args = body.arguments;
      if (
        !sessionId ||
        !connection ||
        !tool ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args)
      )
        throw new IntegralError("invalid MCP request", 400);
      const result = await this.mcpSidecars.callTool(
        sessionId,
        connection,
        tool,
        args as Record<string, unknown>,
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      const status =
        error instanceof IntegralError && error.exitCode >= 400
          ? error.exitCode
          : 500;
      res
        .writeHead(status)
        .end(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  private schedule(ms = 500): void {
    if (!this.stopped)
      this.polling = this.dependencies.clock.setTimeout(
        () => void this.poll(),
        ms,
      );
  }
  private async poll(): Promise<void> {
    await Promise.all([this.runOnce(), this.runTaskOnce()]);
    this.schedule();
  }

  async runTaskOnce(): Promise<void> {
    if (this.taskBusy || this.stopped) return;
    this.taskBusy = true;
    let task: ScheduledTask | undefined,
      runtime: TaskRuntime | undefined,
      exitCode: number | undefined,
      turnStarted: number | undefined;
    try {
      const [coordinatorState, gatewayState, generationRaw] = await Promise.all(
        [
          readComponentState(this.paths, "coordinator"),
          readComponentState(this.paths, "gateway"),
          readText(join(this.paths.state, "connection-generation")),
        ],
      );
      const generation = Number(generationRaw?.trim() || "0");
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
        return;
      await this.ensureGatewayListener();
      const claimed = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        "/integral/internal/tasks/claim",
        { method: "POST", body: "{}" },
      );
      if (!claimed.ok)
        throw new IntegralError(`task claim failed: ${claimed.status}`);
      task = ((await claimed.json()) as { task?: ScheduledTask }).task;
      if (!task) return;
      if (!task.claimId)
        throw new IntegralError("claimed task has no claim ID");
      this.currentTask = { id: task.id, claimId: task.claimId };
      runtime = await this.createTaskRuntime(task);
      this.activeTaskRuntime = runtime;
      await runtime.start();
      const started = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        `/integral/internal/tasks/${task.id}/start`,
        {
          method: "POST",
          body: JSON.stringify({ claimId: task.claimId }),
        },
      );
      if (!started.ok)
        throw new IntegralError(`task start failed: ${started.status}`);
      const running = (await started.json()) as ScheduledTask,
        attempt = running.attempts.at(-1);
      if (!attempt) throw new IntegralError("started task has no attempt");
      this.currentTask.attemptId = attempt.attemptId;
      await this.taskRun?.annotate({
        attemptId: attempt.attemptId,
        attemptNumber: attempt.number,
        retryNumber: Math.max(0, attempt.number - 1),
      });
      const taskSession = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "gateway",
        "/integral/internal/session",
        {
          method: "POST",
          body: JSON.stringify({
            token: runtime.spec.sessionToken,
            sessionId: runtime.spec.sessionId,
            executionId: task.executionId,
            attemptId: attempt.attemptId,
          }),
        },
      );
      if (!taskSession.ok)
        throw new IntegralError(
          `task gateway identity update failed: ${taskSession.status}`,
        );
      await this.taskRun?.input(
        task.prompt,
        task.attempts.length > 0 ? "retry-instruction" : "original-request",
        { executionId: task.executionId },
      );
      turnStarted = this.dependencies.now();
      const answer = await runtime.prompt(task.prompt);
      await this.taskRun?.output(answer, this.dependencies.now() - turnStarted);
      exitCode = await runtime.finish();
      const finalized = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        `/integral/internal/tasks/${task.id}/finalize`,
        {
          method: "POST",
          body: JSON.stringify({
            attemptId: attempt.attemptId,
            exitCode,
          }),
        },
      );
      if (!finalized.ok)
        throw new IntegralError(
          `task finalization failed: ${finalized.status}`,
        );
      const finalizedText = await finalized.text(),
        finalizedTask = finalizedText
          ? (JSON.parse(finalizedText) as ScheduledTask)
          : undefined,
        finalizedAttempt = finalizedTask?.attempts.find(
          (candidate) => candidate.attemptId === attempt.attemptId,
        ),
        taskSucceeded = finalizedTask
          ? finalizedTask.state === "completed"
          : exitCode === 0,
        termination: RunTermination = taskSucceeded
          ? "completed"
          : finalizedTask?.state === "cancelled"
            ? "cancelled"
            : "failed";
      await this.finalizeRun(this.taskRun, {
        termination,
        ...(taskSucceeded
          ? {}
          : {
              error:
                finalizedTask?.lastError ??
                `Pi task exited non-zero (${exitCode})`,
            }),
        ...(finalizedAttempt?.declaration
          ? { declaration: finalizedAttempt.declaration }
          : {}),
      });
      this.currentTask = undefined;
    } catch (error) {
      await this.taskRun?.failure("task-failure", error, {
        ...(turnStarted !== undefined
          ? { turnElapsedMs: this.dependencies.now() - turnStarted }
          : {}),
      });
      const message = error instanceof Error ? error.message : String(error);
      await this.finalizeRun(this.taskRun, {
        termination: /timed out|timeout/i.test(message)
          ? "timed-out"
          : /cancel/i.test(message)
            ? "cancelled"
            : "failed",
        error: message,
      });
      if (task && this.currentTask) {
        const attemptId = this.currentTask.attemptId,
          action = attemptId ? "fail" : "defer",
          body = attemptId
            ? {
                attemptId,
                error: error instanceof Error ? error.message : String(error),
                ...(exitCode === undefined ? {} : { exitCode }),
              }
            : {
                claimId: this.currentTask.claimId,
                error: error instanceof Error ? error.message : String(error),
              };
        await this.dependencies
          .internalFetch(
            this.paths,
            "runner",
            "coordinator",
            `/integral/internal/tasks/${task.id}/${action}`,
            { method: "POST", body: JSON.stringify(body) },
          )
          .catch(() => undefined);
      }
      this.logger.event(
        "warn",
        "runner.task_failed",
        error instanceof Error ? error.message : String(error),
        task
          ? {
              schedule_id: task.scheduleId,
              execution_id: task.executionId,
              ...(this.currentTask?.attemptId
                ? { attempt_id: this.currentTask.attemptId }
                : {}),
            }
          : {},
      );
      this.currentTask = undefined;
    } finally {
      await this.finalizeRun(this.taskRun, {
        termination: this.stopped ? "stopped" : "failed",
        ...(this.stopped ? {} : { error: "task execution did not complete" }),
      });
      if (runtime) {
        await this.mcpSidecars.stop(runtime.spec.sessionId);
        await this.revoke(runtime.spec.sessionToken);
        if (this.taskResources)
          await this.dependencies
            .cleanupResourceProjection(
              this.paths,
              this.config,
              this.taskResources,
            )
            .catch(() => undefined);
        await runtime.stop().catch(() => undefined);
      }
      await this.removeHistoryView(this.taskHistoryView);
      this.taskRun = undefined;
      this.taskHistoryView = undefined;
      this.taskResources = undefined;
      if (this.activeTaskRuntime === runtime)
        this.activeTaskRuntime = undefined;
      this.taskBusy = false;
    }
  }

  private async createTaskRuntime(task: ScheduledTask): Promise<TaskRuntime> {
    const resolvedImage = await this.dependencies.containers.ensureImage(
      this.config,
      task.profile.piVersion,
      { expectedImage: task.profile.piImage },
    );
    if (resolvedImage !== task.profile.piImage)
      throw new IntegralError(
        `scheduled Pi image ${task.profile.piImage} is unavailable`,
      );
    const { spec, identity, resources, catalogs, sidecars } =
      await this.preparePiEnvironment(task.profile, task.profile.piImage);
    this.taskResources = resources;
    await this.dependencies.writeTaskExtension(spec.home);
    spec.args.push(
      "--extension",
      "/home/pi/.integral/extensions/integral-task.ts",
    );
    spec.args.push("--append-system-prompt", renderTaskContext(task));
    const previous = await this.runs.finalizedForExecution(task.executionId),
      recorder = await this.runs.begin({
        kind: "scheduled",
        sessionId: identity.sessionId,
        model: task.profile,
        config: this.config,
        scheduleId: task.scheduleId,
        executionId: task.executionId,
        attemptNumber: task.attempts.length + 1,
        retryNumber: task.attempts.length,
        ...(previous.at(-1)?.runId
          ? { priorAttemptRunId: previous.at(-1)!.runId }
          : {}),
        sensitiveValues: [identity.sessionToken],
      });
    await recordResourceProjection(recorder, resources);
    await recorder.event("host", "runtime-context", {
      text: renderTaskContext(task),
    });
    this.taskRun = recorder;
    let historyView: string | undefined, runtime: TaskRuntime | undefined;
    try {
      historyView = await this.runs.createHistoryView(recorder);
      this.taskHistoryView = historyView;
      spec.mounts.push({
        source: historyView,
        target: "/home/pi/history",
        readonly: true,
      });
      runtime = this.dependencies.containers.createTaskPi(
        spec,
        this.config,
        `integral-${deploymentId(this.paths)}`,
        (line) => {
          this.logger.event("debug", "pi.stderr", line, {
            schedule_id: task.scheduleId,
            execution_id: task.executionId,
            session_id: identity.sessionId,
          });
          void recorder
            .event("pi", "stderr", { line })
            .catch((error) =>
              this.logger.event(
                "error",
                "runner.run_event_failed",
                error instanceof Error ? error.message : String(error),
                { run_id: recorder.runId },
              ),
            );
        },
        (event) => recorder.protocol(event),
      );
      const registered = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "gateway",
        "/integral/internal/session",
        {
          method: "POST",
          body: JSON.stringify({
            token: identity.sessionToken,
            sessionId: identity.sessionId,
            runId: recorder.runId,
          }),
        },
      );
      if (!registered.ok)
        throw new IntegralError(
          `task gateway session unavailable: ${registered.status}`,
        );
      await this.mcpSidecars.start(spec, catalogs, sidecars);
      return runtime;
    } catch (error) {
      await recorder.failure("provisioning-failure", error);
      await this.finalizeRun(recorder, {
        termination: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await this.mcpSidecars.stop(identity.sessionId);
      await this.revoke(identity.sessionToken);
      await this.dependencies
        .cleanupResourceProjection(this.paths, this.config, resources)
        .catch(() => undefined);
      if (runtime) await runtime.stop().catch(() => undefined);
      else await rm(spec.home, { recursive: true, force: true });
      await this.removeHistoryView(historyView);
      this.taskRun = undefined;
      this.taskHistoryView = undefined;
      throw error;
    }
  }
  async runOnce(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let item: QueuedMessage | undefined, turnStarted: number | undefined;
    try {
      const [coordinatorState, gatewayState, generationRaw, sessionRaw] =
        await Promise.all([
          readComponentState(this.paths, "coordinator"),
          readComponentState(this.paths, "gateway"),
          readText(join(this.paths.state, "connection-generation")),
          readText(join(this.paths.state, "session-generation")),
        ]);
      const generation = Number(generationRaw?.trim() || "0"),
        sessionGeneration = Number(sessionRaw?.trim() || generation);
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
        throw new IntegralError(
          "component configuration or connection generations disagree",
        );
      if (this.pi && this.piSessionGeneration !== sessionGeneration)
        await this.destroyPi();
      await this.ensureGatewayListener();
      const gateway = await this.dependencies.fetch(
        new URL(
          "/integral/health",
          await componentEndpoint(this.paths, "gateway"),
        ),
      );
      if (!gateway.ok) throw new IntegralError("gateway unavailable");
      const response = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        "/integral/internal/claim",
        { method: "POST", body: "{}" },
      );
      if (!response.ok)
        throw new IntegralError(`claim failed: ${response.status}`);
      const body = (await response.json()) as {
        message?: QueuedMessage;
        context: ConversationEvent[];
        selection?: ModelSelection | null;
        conversationId?: string;
      };
      const conversationId = body.conversationId ?? "terminal";
      const selection = body.selection ?? undefined;
      item = body.message;
      if (!item) {
        this.armIdle();
        return;
      }
      if (this.pi && this.piConversationId !== conversationId)
        await this.destroyPi("selection-changed");
      if (this.pi && !sameSelection(this.piSelection, selection))
        await this.destroyPi("selection-changed");
      this.currentMessageId = item.id;
      this.currentConversationId = conversationId;
      this.steeredMessageIds = [];
      if (!selection)
        throw new IntegralError(
          "conversation has no selected model connection and model",
        );
      this.dependencies.clock.clearTimeout(this.idle);
      const continuation = item.approvalContinuation;
      if (continuation && this.pi) await this.destroyPi("selection-changed");
      if (this.pi && (await this.mcpCatalogChanged()))
        await this.destroyPi("selection-changed");
      await this.ensurePi(
        body.context,
        selection,
        sessionGeneration,
        continuation,
        item.origin,
      );
      this.piConversationId = conversationId;
      const activeRun = this.piRun;
      await activeRun?.input(
        item.text,
        item.attempts > 1
          ? "retry-instruction"
          : continuation
            ? "approval-resolution"
            : this.piTurnCount === 0
              ? "original-request"
              : "follow-up",
        {
          messageId: item.id,
          ...(activeRun ? { runId: activeRun.runId } : {}),
        },
      );
      turnStarted = this.dependencies.now();
      const answer = await this.pi!.prompt(item.text);
      await this.piRun?.output(answer, this.dependencies.now() - turnStarted);
      this.piTurnCount++;
      const completed = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        `/integral/internal/work/${item.id}/complete`,
        {
          method: "POST",
          body: JSON.stringify({
            text: answer,
            conversationId,
            steeredMessageIds: this.steeredMessageIds,
          }),
        },
      );
      if (!completed.ok)
        throw new IntegralError(`completion failed: ${completed.status}`);
      this.currentMessageId = undefined;
      this.currentConversationId = undefined;
    } catch (error) {
      await this.piRun?.failure("turn-failure", error, {
        ...(turnStarted !== undefined
          ? { turnElapsedMs: this.dependencies.now() - turnStarted }
          : {}),
      });
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
            `/integral/internal/work/${item.id}/release`,
            {
              method: "POST",
              body: JSON.stringify({
                reason: error instanceof Error ? error.message : String(error),
                conversationId: this.currentConversationId ?? "terminal",
                steeredMessageIds: this.steeredMessageIds,
              }),
            },
          )
          .catch(() => undefined);
        this.currentMessageId = undefined;
        this.currentConversationId = undefined;
      }
      if (
        this.pi &&
        /gateway|container|timed out|exited|rejected prompt/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        await this.destroyPi(
          /timed out/i.test(
            error instanceof Error ? error.message : String(error),
          )
            ? "timed-out"
            : "failed",
          error instanceof Error ? error.message : String(error),
        );
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
      "/integral/internal/docker-listener",
      { method: "POST", body: JSON.stringify({ address: this.dockerGateway }) },
    );
    if (!response.ok)
      throw new IntegralError(
        `gateway Docker listener unavailable: ${response.status}`,
      );
  }
  private async ensurePi(
    context: ConversationEvent[],
    selection: ModelSelection,
    sessionGeneration: number,
    continuation?: ApprovalContinuation,
    origin?: QueuedMessage["origin"],
  ): Promise<void> {
    if (this.pi) return;
    const resolvedImage = await this.dependencies.containers.ensureImage(
      this.config,
      selection.piVersion,
      { expectedImage: selection.piImage },
    );
    if (resolvedImage !== selection.piImage)
      throw new IntegralError(
        `selected Pi image ${selection.piImage} is unavailable; run /model to refresh the runtime selection`,
      );
    const { spec, identity, resources, catalogs, sidecars } =
      await this.preparePiEnvironment(selection, selection.piImage);
    if (context.length)
      spec.args.push("--append-system-prompt", renderContext(context));
    const parent = continuation?.originRunId
        ? undefined
        : await this.runs.latestFinalized("interactive"),
      recorder = await this.runs.begin({
        kind: "interactive",
        sessionId: identity.sessionId,
        model: selection,
        config: this.config,
        ...(continuation?.originRunId
          ? { parentRunId: continuation.originRunId }
          : parent
            ? { parentRunId: parent.runId }
            : {}),
        ...(continuation
          ? {
              parentSessionId: continuation.originSessionId,
              approvalId: continuation.approvalId,
            }
          : {}),
        sensitiveValues: [identity.sessionToken],
      });
    await recordResourceProjection(recorder, resources);
    if (context.length)
      await recorder.event("host", "runtime-context", {
        text: renderContext(context),
      });
    let historyView: string | undefined, pi: PiRuntime | undefined;
    try {
      historyView = await this.runs.createHistoryView(recorder);
      spec.mounts.push({
        source: historyView,
        target: "/home/pi/history",
        readonly: true,
      });
      pi = this.dependencies.containers.createPi(
        spec,
        this.config,
        `integral-${deploymentId(this.paths)}`,
        (line) => {
          this.logger.event("debug", "pi.stderr", line, {
            session_id: identity.sessionId,
          });
          void recorder
            .event("pi", "stderr", { line })
            .catch((error) =>
              this.logger.event(
                "error",
                "runner.run_event_failed",
                error instanceof Error ? error.message : String(error),
                { run_id: recorder.runId },
              ),
            );
        },
        (event) => recorder.protocol(event),
      );
      const registered = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "gateway",
        "/integral/internal/session",
        {
          method: "POST",
          body: JSON.stringify({
            token: identity.sessionToken,
            sessionId: identity.sessionId,
            runId: recorder.runId,
            conversationId: this.currentConversationId ?? "terminal",
            ...(origin
              ? {
                  origin: {
                    ...origin,
                    conversationId: this.currentConversationId ?? "terminal",
                  },
                }
              : {}),
          }),
        },
      );
      if (!registered.ok)
        throw new IntegralError(
          `gateway session unavailable: ${registered.status}`,
        );
      await this.mcpSidecars.start(spec, catalogs, sidecars);
      await pi.start();
      this.pi = pi;
      this.piSelection = { ...selection };
      this.piSessionGeneration = sessionGeneration;
      this.piRun = recorder;
      this.piHistoryView = historyView;
      this.piResources = resources;
      this.piMcpCatalogs = new Map(
        catalogs.map((catalog) => [
          catalog.connection.name,
          mcpCatalogSignature(catalog),
        ]),
      );
      this.piTurnCount = 0;
      await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        "/integral/internal/session",
        {
          method: "POST",
          body: JSON.stringify({
            sessionId: identity.sessionId,
            state: "started",
            conversationId: this.currentConversationId ?? "terminal",
            ...(continuation
              ? {
                  parentSessionId: continuation.originSessionId,
                  approvalId: continuation.approvalId,
                }
              : {}),
          }),
        },
      );
    } catch (error) {
      await recorder.failure("provisioning-failure", error);
      await this.finalizeRun(recorder, {
        termination: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await this.mcpSidecars.stop(identity.sessionId);
      await this.revoke(identity.sessionToken);
      await this.dependencies
        .cleanupResourceProjection(this.paths, this.config, resources)
        .catch(() => undefined);
      if (pi) await pi.stop();
      else await rm(spec.home, { recursive: true, force: true });
      await this.removeHistoryView(historyView);
      throw error;
    }
  }
  private async preparePiEnvironment(selection: ModelSelection, image: string) {
    const all = await listConnections(this.paths),
      active = all.filter((connection) => connection.state === "active"),
      model = selectModel(all, selection),
      mcp = active.filter((connection) => connection.kind === "mcp"),
      email = active.filter((connection) => connection.kind === "email"),
      identity = this.dependencies.newSessionIdentity(),
      ca = await this.dependencies.ensureCa(this.paths),
      home = await this.dependencies.freshSessionHome();
    const catalogs: McpCatalog[] = [],
      stdio: Array<{
        connection: Connection;
        secretValues: Record<string, string>;
      }> = [],
      unavailableMcp: string[] = [],
      mcpDiagnostics: string[] = [];
    for (const connection of mcp) {
      try {
        const raw = await credentialFor(this.paths, connection.name),
          credential = raw ? (oauthAccess(raw) ?? raw) : undefined;
        if (connection.transport === "stdio") {
          let parsed: unknown = { type: "stdio-env", values: {} };
          if (raw?.trim()) parsed = JSON.parse(raw);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            !("values" in parsed) ||
            !parsed.values ||
            typeof parsed.values !== "object" ||
            Array.isArray(parsed.values)
          )
            throw new IntegralError("invalid stdio secret credential");
          const values = parsed.values as Record<string, unknown>,
            secretValues: Record<string, string> = {};
          for (const name of connection.secretEnv ?? []) {
            if (typeof values[name] !== "string")
              throw new IntegralError(`missing stdio secret ${name}`);
            secretValues[name] = values[name];
          }
          stdio.push({ connection, secretValues });
          continue;
        }
        const catalog = await this.mcpCatalogs.refresh(
          connection,
          credential,
          this.dependencies.fetch,
          true,
        );
        await clearConnectionDegraded(this.paths, connection.name);
        catalogs.push(catalog);
        mcpDiagnostics.push(
          ...(catalog.diagnostics ?? []).map(
            (diagnostic) => `${connection.name}: ${diagnostic}`,
          ),
        );
      } catch (error) {
        await markConnectionDegraded(
          this.paths,
          connection.name,
          /401|403|authoriz/i.test(
            error instanceof Error ? error.message : String(error),
          )
            ? "authorization"
            : "discovery",
        );
        unavailableMcp.push(
          `${connection.name} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    const resources = await this.dependencies.prepareResourceProjection(
      this.paths,
      this.config,
      home,
      identity.sessionId,
    );
    await this.dependencies.writeMcpExtension(home, catalogs);
    await this.dependencies.writeEmailExtension(home, email);
    await this.dependencies.writeResourceExtension(home, resources);
    await this.dependencies.writePiCredential(home, model);
    const gatewayUrl = new URL(await componentEndpoint(this.paths, "gateway"));
    gatewayUrl.hostname = "host.integral.internal";
    const sidecars: McpSidecarSpec[] = stdio.map(
      ({ connection, secretValues }) => ({
        connection,
        image,
        sessionId: identity.sessionId,
        sessionToken: identity.sessionToken,
        gatewayUrl: gatewayUrl.toString(),
        gatewayAddress: this.dockerGateway,
        caCert: ca.cert,
        caBundle: ca.bundle,
        secretValues,
      }),
    );
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
      image,
      mcp,
      connections: active,
    });
    for (const extension of [
      "integral-mcp.ts",
      "integral-resources.ts",
      ...(email.length ? ["integral-email.ts"] : []),
    ])
      spec.args.push(
        "--extension",
        `/home/pi/.integral/extensions/${extension}`,
      );
    spec.args.push(
      "--append-system-prompt",
      "You run in an ephemeral Integral-managed container. The active image Dockerfile is in /home/pi/image. You may edit and commit it, then call repo_push for image-recipe; that proposal requires human approval and affects a replacement container, not this running filesystem. Use container_image_rebuild to request an approval-gated fresh rebuild of the unchanged recipe.",
    );
    spec.mounts.push(...resources.mounts);
    if (
      resources.unavailable.length ||
      unavailableMcp.length ||
      mcpDiagnostics.length
    )
      spec.args.push(
        "--append-system-prompt",
        [
          ...(resources.unavailable.length
            ? [
                `Unavailable governed resources: ${resources.unavailable
                  .map((value) => `${value.name} (${value.reason})`)
                  .join(", ")}. Host paths are intentionally hidden.`,
              ]
            : []),
          ...(unavailableMcp.length
            ? [`Unavailable MCP connections: ${unavailableMcp.join(", ")}.`]
            : []),
          ...(mcpDiagnostics.length
            ? [`Excluded MCP tools: ${mcpDiagnostics.join(", ")}.`]
            : []),
        ].join(" "),
      );
    return {
      identity,
      resources,
      spec,
      catalogs,
      sidecars,
    };
  }
  private armIdle(): void {
    if (!this.pi || this.idle) return;
    this.idle = this.dependencies.clock.setTimeout(
      () => this.destroyPi("idle"),
      this.config.runner.idleTimeoutSeconds * 1000,
    );
  }
  private async mcpCatalogChanged(): Promise<boolean> {
    const connections = (await listConnections(this.paths)).filter(
      (connection) =>
        connection.kind === "mcp" &&
        connection.transport !== "stdio" &&
        connection.state !== "DISABLED (no secret)",
    );
    for (const connection of connections) {
      try {
        const raw = await credentialFor(this.paths, connection.name),
          credential = raw ? (oauthAccess(raw) ?? raw) : undefined,
          catalog = await this.mcpCatalogs.refresh(
            connection,
            credential,
            this.dependencies.fetch,
          );
        await clearConnectionDegraded(this.paths, connection.name);
        if (
          this.piMcpCatalogs.get(connection.name) !==
          mcpCatalogSignature(catalog)
        )
          return true;
      } catch (error) {
        await markConnectionDegraded(
          this.paths,
          connection.name,
          /401|403|authoriz/i.test(
            error instanceof Error ? error.message : String(error),
          )
            ? "authorization"
            : "discovery",
        );
      }
    }
    return connections.length !== this.piMcpCatalogs.size;
  }
  private async revoke(token: string): Promise<void> {
    await this.dependencies
      .internalFetch(
        this.paths,
        "runner",
        "gateway",
        "/integral/internal/session",
        {
          method: "DELETE",
          body: JSON.stringify({ token }),
        },
      )
      .catch(() => undefined);
  }
  private async destroyPi(
    termination: RunTermination = "stopped",
    error?: string,
  ): Promise<void> {
    this.dependencies.clock.clearTimeout(this.idle);
    this.idle = undefined;
    const pi = this.pi;
    const conversationId = this.piConversationId ?? "terminal";
    const recorder = this.piRun,
      historyView = this.piHistoryView,
      resources = this.piResources;
    this.pi = undefined;
    this.piSelection = undefined;
    this.piSessionGeneration = undefined;
    this.piConversationId = undefined;
    this.piRun = undefined;
    this.piHistoryView = undefined;
    this.piResources = undefined;
    this.piMcpCatalogs = new Map();
    this.piTurnCount = 0;
    if (pi) {
      await this.finalizeRun(recorder, {
        termination,
        ...(error ? { error } : {}),
      });
      await this.mcpSidecars.stop(pi.spec.sessionId);
      await this.revoke(pi.spec.sessionToken);
      if (resources)
        await this.dependencies
          .cleanupResourceProjection(this.paths, this.config, resources)
          .catch(() => undefined);
      await pi.stop();
      await this.removeHistoryView(historyView);
      await this.dependencies
        .internalFetch(
          this.paths,
          "runner",
          "coordinator",
          "/integral/internal/session",
          {
            method: "POST",
            body: JSON.stringify({
              sessionId: pi.spec.sessionId,
              state: "ended",
              conversationId,
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
          `/integral/internal/work/${messageId}/release`,
          {
            method: "POST",
            body: JSON.stringify({ reason: "runner stopped" }),
          },
        )
        .catch(() => undefined);
    const task = this.currentTask;
    this.currentTask = undefined;
    if (task)
      await this.dependencies
        .internalFetch(
          this.paths,
          "runner",
          "coordinator",
          `/integral/internal/tasks/${task.id}/${task.attemptId ? "fail" : "defer"}`,
          {
            method: "POST",
            body: JSON.stringify(
              task.attemptId
                ? { attemptId: task.attemptId, error: "runner stopped" }
                : { claimId: task.claimId, error: "runner stopped" },
            ),
          },
        )
        .catch(() => undefined);
    const taskRuntime = this.activeTaskRuntime;
    this.activeTaskRuntime = undefined;
    if (taskRuntime) {
      await this.finalizeRun(this.taskRun, {
        termination: "stopped",
        error: "runner stopped",
      });
      await this.mcpSidecars.stop(taskRuntime.spec.sessionId);
      await this.revoke(taskRuntime.spec.sessionToken);
      await taskRuntime.stop().catch(() => undefined);
      await this.removeHistoryView(this.taskHistoryView);
      this.taskRun = undefined;
      this.taskHistoryView = undefined;
    }
    await this.destroyPi("stopped");
    const server = this.server;
    if (server) await this.dependencies.close(server);
  }

  private async finalizeRun(
    recorder: RunRecorder | undefined,
    options: FinalizeRunOptions,
  ): Promise<void> {
    if (!recorder) return;
    try {
      await recorder.finalize(options);
    } catch (error) {
      this.logger.event(
        "error",
        "runner.run_finalize_failed",
        error instanceof Error ? error.message : String(error),
        { run_id: recorder.runId },
      );
    }
  }

  private async removeHistoryView(path: string | undefined): Promise<void> {
    try {
      await this.runs.removeHistoryView(path);
    } catch (error) {
      this.logger.event(
        "warn",
        "runner.history_cleanup_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function mcpCatalogSignature(catalog: McpCatalog): string {
  return JSON.stringify(
    catalog.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    })),
  );
}

export async function validateRunnerHost(paths: IntegralPaths): Promise<void> {
  const connections = await listConnections(paths);
  requireActiveModelConnection(connections);
  if (!dockerAvailable())
    throw new IntegralError("Docker daemon is unavailable");
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
    throw new IntegralError(
      "no active model connection; run integral connection add",
    );
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
    throw new IntegralError(
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

export function renderTaskContext(task: ScheduledTask): string {
  const attempt = task.attempts.length + 1;
  return `You are executing an isolated scheduled task.\nSchedule ID: ${task.scheduleId}\nExecution ID: ${task.executionId}\nAttempt: ${attempt}\nScheduled time: ${task.scheduledFor}\nComplete only the supplied task. Do not assume access to the interactive conversation. Use the execution ID as an idempotency key for external side effects. Before ending, call exactly one of task_complete or task_fail as your final action.`;
}

async function runnerBodyJson(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return await readJsonObject(req);
}
