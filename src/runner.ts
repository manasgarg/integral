import http from "node:http";
import type { EffectiveConfig } from "./config.ts";
import { listConnections, type Connection } from "./connections.ts";
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
  writePiCredential,
  type ContainerBackend,
  type PiRuntime,
  type TaskRuntime,
} from "./container.ts";
import { ensureCa } from "./ca.ts";
import { componentEndpoint, internalFetch } from "./http-client.ts";
import { deploymentId, readComponentState } from "./state.ts";
import { updateComponentState } from "./state.ts";
import { readText } from "./fs.ts";
import { join } from "node:path";
import { IntegralError } from "./errors.ts";
import type { ConversationEvent, QueuedMessage } from "./queue.ts";
import { sameSelection, type ModelSelection } from "./model-selection.ts";
import type { ScheduledTask } from "./task-queue.ts";

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
  writeEmailExtension: typeof writeEmailExtension;
  writeTaskExtension: typeof writeTaskExtension;
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
  writeEmailExtension,
  writeTaskExtension,
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
  private taskBusy = false;
  private idle: unknown;
  private dockerGateway = "";
  private currentMessageId: string | undefined;
  private currentTask:
    { id: string; claimId: string; attemptId?: string } | undefined;
  private activeTaskRuntime: TaskRuntime | undefined;
  private piSelection: ModelSelection | undefined;
  private piConnectionGeneration: number | undefined;
  private readonly dependencies: RunnerDependencies;
  constructor(
    private readonly paths: IntegralPaths,
    private readonly config: EffectiveConfig,
    private readonly logger: Logger,
    overrides: Partial<RunnerDependencies> = {},
  ) {
    this.dependencies = { ...productionDependencies, ...overrides };
  }
  async start(): Promise<http.Server> {
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
    await Promise.all([this.runOnce(), this.runTaskOnce()]);
    this.schedule();
  }

  async runTaskOnce(): Promise<void> {
    if (this.taskBusy || this.stopped) return;
    this.taskBusy = true;
    let task: ScheduledTask | undefined,
      runtime: TaskRuntime | undefined,
      exitCode: number | undefined;
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
      await runtime.prompt(task.prompt);
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
      this.currentTask = undefined;
    } catch (error) {
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
      if (runtime) {
        await this.revoke(runtime.spec.sessionToken);
        await runtime.stop().catch(() => undefined);
      }
      if (this.activeTaskRuntime === runtime)
        this.activeTaskRuntime = undefined;
      this.taskBusy = false;
    }
  }

  private async createTaskRuntime(task: ScheduledTask): Promise<TaskRuntime> {
    const resolvedImage = await this.dependencies.containers.ensureImage(
      this.config,
      task.profile.piVersion,
    );
    if (resolvedImage !== task.profile.piImage)
      throw new IntegralError(
        `scheduled Pi image ${task.profile.piImage} is unavailable`,
      );
    const { spec, identity } = await this.preparePiEnvironment(
      task.profile,
      task.profile.piImage,
    );
    await this.dependencies.writeTaskExtension(spec.home);
    spec.args.push("--append-system-prompt", renderTaskContext(task));
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
        }),
      },
    );
    if (!registered.ok) {
      await this.revoke(identity.sessionToken);
      throw new IntegralError(
        `task gateway session unavailable: ${registered.status}`,
      );
    }
    return this.dependencies.containers.createTaskPi(
      spec,
      this.config,
      `integral-${deploymentId(this.paths)}`,
      (line) =>
        this.logger.event("debug", "pi.stderr", line, {
          schedule_id: task.scheduleId,
          execution_id: task.executionId,
          session_id: identity.sessionId,
        }),
    );
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
        throw new IntegralError(
          "component configuration or connection generations disagree",
        );
      if (this.pi && this.piConnectionGeneration !== generation)
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
        throw new IntegralError(
          "conversation has no selected model connection and model",
        );
      this.dependencies.clock.clearTimeout(this.idle);
      await this.ensurePi(body.context, selection, generation);
      const answer = await this.pi!.prompt(item.text);
      const completed = await this.dependencies.internalFetch(
        this.paths,
        "runner",
        "coordinator",
        `/integral/internal/work/${item.id}/complete`,
        { method: "POST", body: JSON.stringify({ text: answer }) },
      );
      if (!completed.ok)
        throw new IntegralError(`completion failed: ${completed.status}`);
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
            `/integral/internal/work/${item.id}/release`,
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
    connectionGeneration: number,
  ): Promise<void> {
    if (this.pi) return;
    const resolvedImage = await this.dependencies.containers.ensureImage(
      this.config,
      selection.piVersion,
    );
    if (resolvedImage !== selection.piImage)
      throw new IntegralError(
        `selected Pi image ${selection.piImage} is unavailable; run /model to refresh the runtime selection`,
      );
    const { spec, identity } = await this.preparePiEnvironment(
      selection,
      selection.piImage,
    );
    if (context.length)
      spec.args.push("--append-system-prompt", renderContext(context));
    await this.dependencies.internalFetch(
      this.paths,
      "runner",
      "gateway",
      "/integral/internal/session",
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
      `integral-${deploymentId(this.paths)}`,
      (line) =>
        this.logger.event("debug", "pi.stderr", line, {
          session_id: identity.sessionId,
        }),
    );
    try {
      await pi.start();
      this.pi = pi;
      this.piSelection = { ...selection };
      this.piConnectionGeneration = connectionGeneration;
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
          }),
        },
      );
    } catch (error) {
      await this.revoke(identity.sessionToken);
      await pi.stop();
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
    await this.dependencies.writeMcpExtension(home, mcp);
    await this.dependencies.writeEmailExtension(home, email);
    await this.dependencies.writePiCredential(home, model);
    const gatewayUrl = new URL(await componentEndpoint(this.paths, "gateway"));
    gatewayUrl.hostname = "host.integral.internal";
    return {
      identity,
      spec: buildContainerSpec({
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
      }),
    };
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
  private async destroyPi(): Promise<void> {
    this.dependencies.clock.clearTimeout(this.idle);
    this.idle = undefined;
    const pi = this.pi;
    this.pi = undefined;
    this.piSelection = undefined;
    this.piConnectionGeneration = undefined;
    if (pi) {
      await this.revoke(pi.spec.sessionToken);
      await pi.stop();
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
      await this.revoke(taskRuntime.spec.sessionToken);
      await taskRuntime.stop().catch(() => undefined);
    }
    await this.destroyPi();
    const server = this.server;
    if (server) await this.dependencies.close(server);
  }
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
