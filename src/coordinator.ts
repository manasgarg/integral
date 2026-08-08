import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { EffectiveConfig } from "./config.ts";
import type { IntegralPaths } from "./paths.ts";
import {
  ConversationStore,
  DurableQueue,
  ModelSelectionStore,
} from "./queue.ts";
import {
  listModelChoices,
  sameSelection,
  type ModelCatalog,
  type ModelCatalogProgress,
  type ModelChoice,
} from "./model-selection.ts";
import {
  componentIdentity,
  deploymentId,
  readComponentState,
  updateComponentState,
  verifyInternal,
} from "./state.ts";
import { readText } from "./fs.ts";
import { join } from "node:path";
import { IntegralError } from "./errors.ts";
import {
  nodeHttpServerRuntime,
  nodeIntervalRuntime,
  type HttpServerRuntime,
  type IntervalRuntime,
} from "./runtime.ts";
import { internalFetch } from "./http-client.ts";
import { DurableTaskQueue } from "./task-queue.ts";
import type { ScheduledOccurrence } from "./occurrence-store.ts";
import { DEFAULT_PI_IMAGE, type Component } from "./constants.ts";
import type { Logger } from "./logging.ts";
import { ensureContainerImage } from "./container.ts";
import {
  loadContainerPackageState,
  planContainerPackageChange,
  saveContainerPackageState,
  validateContainerPackageNames,
  type ContainerPackageOperation,
} from "./container-packages.ts";
import {
  ApprovalStore,
  isTerminalApproval,
  publicApproval,
  type ApprovalRecord,
  type PublicApproval,
  type TerminalApprovalStatus,
} from "./approval-store.ts";

export interface ClientEvent {
  sequence: number;
  type: string;
  data: unknown;
}
export interface CoordinatorDependencies {
  servers: HttpServerRuntime;
  intervals: IntervalRuntime;
  internalFetch: typeof internalFetch;
  defer(callback: () => void): unknown;
  cancelDeferred(handle: unknown): void;
  now(): number;
  listModelChoices(
    paths: IntegralPaths,
    config: EffectiveConfig,
    progress?: ModelCatalogProgress,
  ): Promise<ModelCatalog>;
  ensureImage(
    config: EffectiveConfig,
    piVersion: string,
    options: { systemPackages: readonly string[]; rebuild: boolean },
  ): string | Promise<string>;
}
const productionDependencies: CoordinatorDependencies = {
  servers: nodeHttpServerRuntime,
  intervals: nodeIntervalRuntime,
  internalFetch,
  defer: (callback) => setTimeout(callback, 0),
  cancelDeferred: (handle) =>
    clearTimeout(handle as NodeJS.Timeout | undefined),
  now: Date.now,
  listModelChoices: (paths, config, progress) =>
    listModelChoices(paths, config, {}, progress),
  ensureImage: ensureContainerImage,
};
export class Coordinator {
  readonly queue: DurableQueue;
  readonly conversation: ConversationStore;
  readonly modelSelection: ModelSelectionStore;
  readonly tasks: DurableTaskQueue;
  readonly approvals: ApprovalStore;
  private readonly events = new EventEmitter();
  private server: http.Server | undefined;
  private eventSequence = 0;
  private attached = 0;
  private readonly attachments = new Set<string>();
  private readonly approvalWaiters = new Map<
    string,
    {
      sessionId: string;
      resolve(value: PublicApproval): void;
      reject(error: Error): void;
    }
  >();
  private token = "";
  private refreshTimer: unknown;
  private catalogRefresh: unknown;
  private workChain: Promise<unknown> = Promise.resolve();
  private connectionGeneration: number | undefined;
  private readonly modelCatalogs = new Map<string, ModelCatalog>();
  private readonly modelCatalogLoads = new Map<string, Promise<ModelCatalog>>();
  private readonly dependencies: CoordinatorDependencies;
  constructor(
    private readonly paths: IntegralPaths,
    private readonly config: EffectiveConfig,
    overrides: Partial<CoordinatorDependencies> = {},
    private readonly logger?: Logger,
  ) {
    this.dependencies = { ...productionDependencies, ...overrides };
    this.queue = new DurableQueue(paths.queue, (event) =>
      this.broadcast(`queue.${event.type}`, event),
    );
    this.conversation = new ConversationStore(paths.conversation);
    this.modelSelection = new ModelSelectionStore(paths.modelSelection);
    this.tasks = new DurableTaskQueue(paths);
    this.approvals = new ApprovalStore(paths, () => this.dependencies.now());
  }
  async start(): Promise<http.Server> {
    await this.queue.load();
    await this.conversation.load();
    await this.modelSelection.load();
    await this.tasks.load();
    await this.approvals.load();
    this.token = await componentIdentity(this.paths);
    const server = http.createServer((req, res) => void this.route(req, res));
    this.server = server;
    await this.dependencies.servers.listen(
      server,
      this.config.server.coordinatorPort,
      "127.0.0.1",
    );
    this.refreshTimer = this.dependencies.intervals.setInterval(
      () => void this.refresh(),
      500,
    );
    this.catalogRefresh = this.dependencies.defer(() => {
      this.catalogRefresh = undefined;
      void this.modelCatalog().catch(() => undefined);
    });
    for (const approval of this.approvals
      .records()
      .filter((record) => record.status === "approved"))
      this.dependencies.defer(() => void this.executeApproval(approval));
    return server;
  }
  private async refresh(): Promise<void> {
    await Promise.all([
      this.adoptGeneration(),
      this.flushTaskOutbox(),
      this.expireApprovals(),
    ]);
  }

  async flushTaskOutbox(): Promise<void> {
    for (const entry of this.tasks.outbox()) {
      const response = await this.dependencies
        .internalFetch(
          this.paths,
          "coordinator",
          "scheduler",
          `/integral/internal/occurrences/${entry.executionId}/ack`,
          { method: "POST", body: JSON.stringify(entry) },
        )
        .catch(() => undefined);
      if (response?.ok) await this.tasks.acknowledgeOutbox(entry.executionId);
    }
  }
  private async adoptGeneration(): Promise<void> {
    const generation = Number(
      (
        await readText(join(this.paths.state, "connection-generation"))
      )?.trim() || "0",
    );
    const changed = this.connectionGeneration !== generation;
    this.connectionGeneration = generation;
    await updateComponentState(this.paths, "coordinator", {
      connectionGeneration: generation,
      status: "ready",
    });
    if (changed) void this.modelCatalog(generation).catch(() => undefined);
  }
  private broadcast(type: string, data: unknown): ClientEvent {
    const event = { sequence: ++this.eventSequence, type, data };
    this.events.emit("event", event);
    return event;
  }
  private snapshot(): Record<string, unknown> {
    return {
      deploymentId: deploymentId(this.paths),
      conversation: this.conversation.snapshot(),
      queue: this.queue.snapshot(),
      tasks: this.tasks.snapshot(),
      modelSelection: this.modelSelection.get() ?? null,
      approvals: this.approvals.snapshot(),
      eventSequence: this.eventSequence,
      attached: this.attached,
    };
  }
  private internal(
    req: IncomingMessage,
    expected: Component | Component[] = "runner",
  ): boolean {
    return verifyInternal(
      req.headers,
      expected,
      this.token,
      deploymentId(this.paths),
    );
  }
  async modelMenu(): Promise<{
    choices: ModelChoice[];
    current: ModelChoice | null;
    piVersion?: string;
    warning?: string;
  }> {
    const catalog = await this.modelCatalog();
    return {
      choices: catalog.choices,
      current: this.modelSelection.get() ?? null,
      ...(catalog.piVersion ? { piVersion: catalog.piVersion } : {}),
      ...(catalog.warning ? { warning: catalog.warning } : {}),
    };
  }
  async selectConversationModel(
    connection: string,
    model: string,
  ): Promise<ModelChoice> {
    return this.exclusiveWork(async () => {
      if (this.queue.snapshot().some((item) => item.status === "in-flight"))
        throw new IntegralError(
          "cannot change model selection while a Pi turn is in flight",
          409,
        );
      const catalog = await this.modelCatalog(),
        choice = catalog.choices.find(
          (candidate) =>
            candidate.connection === connection && candidate.model === model,
        );
      if (!choice)
        throw new IntegralError(
          "selected model connection or model is no longer available",
          409,
        );
      const previous = this.modelSelection.get();
      if (!sameSelection(previous, choice)) {
        await this.modelSelection.set(choice);
        this.broadcast("conversation.selection", choice);
      }
      return choice;
    });
  }
  async containerPackageInventory(): Promise<Record<string, unknown>> {
    const state = await loadContainerPackageState(this.paths),
      selection = this.modelSelection.get();
    return {
      revision: state.revision,
      packages: state.packages,
      piVersion: selection?.piVersion ?? null,
      piImage: selection?.piImage ?? null,
    };
  }
  async changeContainerPackages(input: {
    operation: ContainerPackageOperation;
    packages: unknown;
    expectedRevision: number;
    actor: string;
    approvalId: string;
  }): Promise<Record<string, unknown>> {
    return this.exclusiveWork(async () => {
      if (this.config.runner.image !== DEFAULT_PI_IMAGE)
        throw new IntegralError(
          "container packages can only be changed for Integral's managed Pi image",
          409,
        );
      const selection = this.modelSelection.get();
      if (!selection)
        throw new IntegralError(
          "select a model before changing container packages",
          409,
        );
      const current = await loadContainerPackageState(this.paths),
        requested = validateContainerPackageNames(input.packages);
      const repeated = current.lastApprovalId === input.approvalId,
        planned = repeated
          ? current
          : planContainerPackageChange(
              current,
              input.operation,
              requested,
              input.expectedRevision,
            ),
        next = planned
          ? { ...planned, lastApprovalId: input.approvalId }
          : undefined;
      if (!next) return this.containerPackageInventory();
      const image = await this.dependencies.ensureImage(
          this.config,
          selection.piVersion,
          { systemPackages: next.packages, rebuild: !repeated },
        ),
        updatedSelection = { ...selection, piImage: image };
      if (!repeated) await saveContainerPackageState(this.paths, next);
      await this.modelSelection.set(updatedSelection);
      this.modelCatalogs.clear();
      this.modelCatalogLoads.clear();
      this.broadcast("conversation.selection", updatedSelection);
      this.logger?.event(
        "info",
        "container.packages_updated",
        "managed Pi image packages updated",
        {
          actor: input.actor,
          operation: input.operation,
          packages: requested,
          package_revision: next.revision,
          approval_id: input.approvalId,
          pi_version: selection.piVersion,
          pi_image: image,
        },
      );
      return {
        revision: next.revision,
        packages: next.packages,
        piVersion: selection.piVersion,
        piImage: image,
      };
    });
  }

  async requestContainerPackageApproval(
    input: {
      operation: ContainerPackageOperation;
      packages: unknown;
      expectedRevision: number;
      sessionId: string;
      runId?: string;
    },
    response: ServerResponse,
  ): Promise<PublicApproval> {
    let waiting: Promise<PublicApproval> | undefined;
    await this.exclusiveWork(async () => {
      if (!input.sessionId.trim())
        throw new IntegralError("approval origin session is required", 400);
      if (this.config.runner.image !== DEFAULT_PI_IMAGE)
        throw new IntegralError(
          "container packages can only be changed for Integral's managed Pi image",
          409,
        );
      const selection = this.modelSelection.get();
      if (!selection)
        throw new IntegralError(
          "select a model before changing container packages",
          409,
        );
      const packages = validateContainerPackageNames(input.packages),
        state = await loadContainerPackageState(this.paths);
      planContainerPackageChange(
        state,
        input.operation,
        packages,
        input.expectedRevision,
      );
      const record = await this.approvals.create({
        request: {
          kind: "container-packages",
          operation: input.operation,
          packages,
          expectedRevision: input.expectedRevision,
        },
        sessionId: input.sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        selection,
      });
      waiting = new Promise<PublicApproval>((resolve, reject) => {
        this.approvalWaiters.set(record.id, {
          sessionId: input.sessionId,
          resolve,
          reject,
        });
        response.once("close", () => {
          if (response.writableEnded) return;
          const waiter = this.approvalWaiters.get(record.id);
          if (!waiter) return;
          this.approvalWaiters.delete(record.id);
          waiter.reject(
            new IntegralError(
              "originating approval request disconnected; approval remains pending",
              499,
            ),
          );
        });
      });
      this.broadcast("approval.requested", publicApproval(record));
    });
    return waiting!;
  }

  async decideApproval(
    id: string,
    outcome: "approved" | "denied",
    attachmentId: string,
  ): Promise<PublicApproval> {
    if (!this.attachments.has(attachmentId))
      throw new IntegralError(
        "approval requires an attached human terminal",
        403,
      );
    const existing = this.approvals.get(id);
    if (
      existing.status === "pending" &&
      Date.parse(existing.expiresAt) <= this.dependencies.now()
    ) {
      await this.expireApprovals();
      throw new IntegralError(`approval ${id} is already expired`, 409);
    }
    const decided = await this.exclusiveWork(() =>
      this.approvals.decide(id, outcome, attachmentId),
    );
    this.broadcast("approval.decided", publicApproval(decided));
    if (outcome === "approved") return this.executeApproval(decided);
    await this.deliverApproval(decided);
    return publicApproval(decided);
  }

  private async executeApproval(
    record: ApprovalRecord,
  ): Promise<PublicApproval> {
    let resolved: ApprovalRecord;
    try {
      const packageState = await loadContainerPackageState(this.paths),
        selection = this.modelSelection.get();
      if (
        packageState.lastApprovalId !== record.id &&
        !sameSelection(selection, record.origin.selection)
      )
        throw new IntegralError(
          "approval is stale because the selected Pi runtime changed",
          409,
        );
      const result = await this.changeContainerPackages({
        operation: record.request.operation,
        packages: record.request.packages,
        expectedRevision: record.request.expectedRevision,
        actor: `approval:${record.id}`,
        approvalId: record.id,
      });
      resolved = await this.exclusiveWork(() =>
        this.approvals.resolveExecution(record.id, {
          status: "succeeded",
          result,
        }),
      );
    } catch (error) {
      const stale = error instanceof IntegralError && error.exitCode === 409;
      resolved = await this.exclusiveWork(() =>
        this.approvals.resolveExecution(record.id, {
          status: stale ? "stale" : "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    this.broadcast("approval.resolved", publicApproval(resolved));
    await this.deliverApproval(resolved);
    return publicApproval(resolved);
  }

  private async expireApprovals(): Promise<void> {
    for (const record of await this.approvals.expireDue()) {
      this.broadcast("approval.resolved", publicApproval(record));
      await this.deliverApproval(record);
    }
  }

  private async deliverApproval(record: ApprovalRecord): Promise<void> {
    if (!isTerminalApproval(record)) return;
    const waiter = this.approvalWaiters.get(record.id);
    if (waiter) {
      this.approvalWaiters.delete(record.id);
      waiter.resolve(publicApproval(record));
      return;
    }
    await this.ensureApprovalContinuation(record);
  }

  private async ensureApprovalContinuation(
    record: ApprovalRecord & { status: TerminalApprovalStatus },
  ): Promise<void> {
    if (record.continuationMessageId) return;
    const existing = this.queue
      .snapshot()
      .find((item) => item.approvalContinuation?.approvalId === record.id);
    if (existing) {
      await this.approvals.setContinuation(record.id, existing.id);
      return;
    }
    const detail = record.execution?.result
        ? JSON.stringify(record.execution.result)
        : (record.execution?.error ?? record.status),
      text = `Approval ${record.id} for ${record.summary} resolved as ${record.status}. Outcome: ${detail}. This continues session ${record.origin.sessionId}${record.origin.runId ? ` and run ${record.origin.runId}` : ""}. Review the outcome and continue the conversation.`,
      item = await this.queue.enqueue(text, {
        approvalId: record.id,
        originSessionId: record.origin.sessionId,
        ...(record.origin.runId ? { originRunId: record.origin.runId } : {}),
        outcome: record.status,
        summary: record.summary,
      });
    await this.approvals.setContinuation(record.id, item.id);
  }
  private async modelCatalog(generation?: number): Promise<ModelCatalog> {
    const currentGeneration = generation ?? (await this.readGeneration()),
      key = `${this.config.fingerprint}:${currentGeneration}`,
      cached = this.modelCatalogs.get(key);
    this.connectionGeneration = currentGeneration;
    if (cached) return cached;
    const existing = this.modelCatalogLoads.get(key);
    if (existing) return existing;
    this.logger?.event(
      "info",
      "model_catalog.refresh",
      "refreshing the model catalog",
      { connection_generation: currentGeneration },
    );
    const loading = this.dependencies
      .listModelChoices(this.paths, this.config, (stage, message, context) =>
        this.logger?.event("info", "model_catalog.progress", message, {
          stage,
          ...context,
        }),
      )
      .then((catalog) => {
        this.modelCatalogs.set(key, catalog);
        while (this.modelCatalogs.size > 4)
          this.modelCatalogs.delete(this.modelCatalogs.keys().next().value!);
        this.logger?.event(
          "info",
          "model_catalog.ready",
          "model catalog is ready",
          {
            connection_generation: currentGeneration,
            model_count: catalog.choices.length,
            ...(catalog.piVersion ? { pi_version: catalog.piVersion } : {}),
          },
        );
        return catalog;
      })
      .catch((error: unknown) => {
        this.logger?.event(
          "warn",
          "model_catalog.failed",
          error instanceof Error ? error.message : String(error),
          { connection_generation: currentGeneration },
        );
        throw error;
      })
      .finally(() => this.modelCatalogLoads.delete(key));
    this.modelCatalogLoads.set(key, loading);
    return loading;
  }
  private async readGeneration(): Promise<number> {
    return Number(
      (
        await readText(join(this.paths.state, "connection-generation"))
      )?.trim() || "0",
    );
  }
  private async route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://coordinator");
      if (url.pathname === "/integral/health" && req.method === "GET") {
        const [gateway, runner, scheduler] = await Promise.all([
          readComponentState(this.paths, "gateway"),
          readComponentState(this.paths, "runner"),
          readComponentState(this.paths, "scheduler"),
        ]);
        json(res, 200, {
          component: "coordinator",
          deploymentId: deploymentId(this.paths),
          status:
            gateway?.status === "ready" &&
            runner?.status === "ready" &&
            scheduler?.status === "ready"
              ? "ready"
              : "degraded",
          dependencies: {
            gateway: gateway?.status ?? "unavailable",
            runner: runner?.status ?? "unavailable",
            scheduler: scheduler?.status ?? "unavailable",
          },
        });
        return;
      }
      if (url.pathname === "/integral/snapshot" && req.method === "GET") {
        json(res, 200, this.snapshot());
        return;
      }
      if (url.pathname === "/integral/events" && req.method === "GET") {
        this.stream(req, res);
        return;
      }
      if (url.pathname === "/integral/models" && req.method === "GET") {
        json(res, 200, await this.modelMenu());
        return;
      }
      if (url.pathname === "/integral/selection" && req.method === "PUT") {
        const body = await bodyJson(req),
          connection = stringValue(body.connection),
          model = stringValue(body.model);
        const selection = await this.selectConversationModel(connection, model);
        json(res, 200, selection);
        return;
      }
      if (url.pathname === "/integral/internal/container-packages") {
        if (!this.internal(req, "gateway")) return unauthorized(res);
        if (req.method === "GET") {
          json(res, 200, await this.containerPackageInventory());
          return;
        }
        if (req.method === "POST") {
          const body = await bodyJson(req),
            operation = stringValue(body.operation);
          if (operation !== "install" && operation !== "upgrade")
            throw new IntegralError("invalid package operation", 400);
          const approval = await this.requestContainerPackageApproval(
            {
              operation,
              packages: body.packages,
              expectedRevision: numberValue(body.expectedRevision),
              sessionId: stringValue(body.originSessionId),
              ...(stringValue(body.originRunId)
                ? { runId: stringValue(body.originRunId) }
                : {}),
            },
            res,
          );
          json(res, 200, approval);
          return;
        }
        throw new IntegralError("unsupported package operation", 405);
      }
      if (url.pathname === "/integral/approvals" && req.method === "GET") {
        json(res, 200, this.approvals.snapshot());
        return;
      }
      const approvalDecision = url.pathname.match(
        /^\/integral\/approvals\/([^/]+)\/(approve|deny)$/,
      );
      if (approvalDecision && req.method === "POST") {
        const body = await bodyJson(req);
        json(
          res,
          200,
          await this.decideApproval(
            approvalDecision[1]!,
            approvalDecision[2] === "approve" ? "approved" : "denied",
            stringValue(body.attachmentId),
          ),
        );
        return;
      }
      if (url.pathname === "/integral/messages" && req.method === "POST") {
        if (!this.modelSelection.get())
          throw new IntegralError(
            "select a model before submitting a message",
            409,
          );
        const body = await bodyJson(req),
          text = stringValue(body.text),
          terminalId = stringValue(body.terminalId);
        const item = await this.submitMessage(text, terminalId);
        json(res, 201, item);
        return;
      }
      const queueMatch = url.pathname.match(/^\/integral\/queue\/([^/]+)$/);
      if (queueMatch && req.method === "PATCH") {
        const body = await bodyJson(req),
          item = await this.queue.edit(queueMatch[1]!, stringValue(body.text));
        await this.conversation.editUser(item.id, item.text);
        json(res, 200, item);
        return;
      }
      if (queueMatch && req.method === "DELETE") {
        await this.queue.delete(queueMatch[1]!);
        await this.conversation.deleteUser(queueMatch[1]!);
        res.writeHead(204).end();
        return;
      }
      const taskIngress = url.pathname.match(
        /^\/integral\/internal\/tasks\/([^/]+)$/,
      );
      if (taskIngress && req.method === "PUT") {
        if (!this.internal(req, "scheduler")) return unauthorized(res);
        const body = (await bodyJson(req)) as unknown as ScheduledOccurrence;
        if (body.executionId !== taskIngress[1])
          throw new IntegralError("task execution ID does not match path", 400);
        const task = await this.tasks.accept(body);
        json(res, 200, task);
        return;
      }
      if (
        url.pathname === "/integral/internal/tasks/claim" &&
        req.method === "POST"
      ) {
        if (!this.internal(req)) return unauthorized(res);
        json(res, 200, { task: await this.tasks.claim() });
        return;
      }
      const taskDeclaration = url.pathname.match(
        /^\/integral\/internal\/tasks\/([^/]+)\/declare$/,
      );
      if (taskDeclaration && req.method === "POST") {
        if (!this.internal(req, "gateway")) return unauthorized(res);
        const body = await bodyJson(req),
          outcome = stringValue(body.outcome);
        if (outcome !== "complete" && outcome !== "failed")
          throw new IntegralError("invalid task outcome declaration", 400);
        json(
          res,
          200,
          await this.tasks.declareOutcome(
            taskDeclaration[1]!,
            stringValue(body.attemptId),
            outcome,
            stringValue(body.message),
          ),
        );
        return;
      }
      const taskOutcome = url.pathname.match(
        /^\/integral\/internal\/tasks\/([^/]+)\/(start|defer|complete|fail|finalize)$/,
      );
      if (taskOutcome && req.method === "POST") {
        if (!this.internal(req)) return unauthorized(res);
        const body = await bodyJson(req),
          task =
            taskOutcome[2] === "start"
              ? await this.tasks.start(
                  taskOutcome[1]!,
                  stringValue(body.claimId),
                )
              : taskOutcome[2] === "defer"
                ? await this.tasks.releaseClaim(
                    taskOutcome[1]!,
                    stringValue(body.claimId),
                    stringValue(body.error, "task provisioning failed"),
                  )
                : taskOutcome[2] === "complete"
                  ? await this.tasks.complete(
                      taskOutcome[1]!,
                      stringValue(body.attemptId),
                      stringValue(body.result),
                      numberValue(body.exitCode),
                    )
                  : taskOutcome[2] === "finalize"
                    ? await this.tasks.finalize(
                        taskOutcome[1]!,
                        stringValue(body.attemptId),
                        numberValue(body.exitCode),
                      )
                    : await this.tasks.fail(
                        taskOutcome[1]!,
                        stringValue(body.attemptId),
                        stringValue(body.error, "task failed"),
                        optionalNumber(body.exitCode),
                      );
        json(res, 200, task);
        return;
      }
      const taskCancel = url.pathname.match(
        /^\/integral\/tasks\/([^/]+)\/cancel$/,
      );
      if (taskCancel && req.method === "POST") {
        json(res, 200, await this.tasks.cancel(taskCancel[1]!));
        return;
      }
      if (
        url.pathname === "/integral/internal/claim" &&
        req.method === "POST"
      ) {
        if (!this.internal(req)) return unauthorized(res);
        const result = await this.exclusiveWork(async () => ({
          item: this.modelSelection.get()
            ? await this.queue.claim()
            : undefined,
          selection: this.modelSelection.get(),
        }));
        json(res, 200, {
          message: result.item,
          selection: result.selection ?? null,
          context: this.conversation.context(
            this.config.conversation.contextMaxMessages,
            this.config.conversation.contextMaxChars,
          ),
        });
        return;
      }
      if (
        url.pathname === "/integral/internal/session" &&
        req.method === "POST"
      ) {
        if (!this.internal(req)) return unauthorized(res);
        const body = await bodyJson(req),
          sessionId = stringValue(body.sessionId),
          state = stringValue(body.state);
        if (!sessionId || !["started", "ended"].includes(state))
          throw new IntegralError("invalid session event", 400);
        const event = await this.conversation.append({
          type: "session",
          sessionId,
          text: state,
          ...(stringValue(body.parentSessionId)
            ? { parentSessionId: stringValue(body.parentSessionId) }
            : {}),
          ...(stringValue(body.approvalId)
            ? { approvalId: stringValue(body.approvalId) }
            : {}),
        });
        this.broadcast("conversation.session", event);
        res.writeHead(204).end();
        return;
      }
      const workMatch = url.pathname.match(
        /^\/integral\/internal\/work\/([^/]+)\/(complete|release)$/,
      );
      if (workMatch && req.method === "POST") {
        if (!this.internal(req)) return unauthorized(res);
        const [, id, action] = workMatch;
        const body = await bodyJson(req);
        if (action === "complete") {
          const event = await this.conversation.append({
            type: "assistant",
            messageId: id!,
            text: stringValue(body.text),
          });
          await this.queue.complete(id!);
          this.broadcast("conversation.assistant", event);
        } else {
          await this.queue.release(
            id!,
            stringValue(body.reason, "interrupted"),
          );
          const event = await this.conversation.append({
            type: "error",
            messageId: id!,
            text: stringValue(body.reason, "turn interrupted"),
          });
          this.broadcast("conversation.error", event);
        }
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === "/integral/status" && req.method === "GET") {
        const [gateway, runner, scheduler] = await Promise.all([
          readComponentState(this.paths, "gateway"),
          readComponentState(this.paths, "runner"),
          readComponentState(this.paths, "scheduler"),
        ]);
        const queue = this.queue.snapshot();
        const sessionEvent = this.conversation
          .snapshot()
          .filter((e) => e.type === "session")
          .at(-1);
        json(res, 200, {
          gateway: gateway?.status ?? "unavailable",
          runner: runner?.status ?? "unavailable",
          scheduler: scheduler?.status ?? "unavailable",
          container: sessionEvent?.text === "started" ? "healthy" : "stopped",
          session:
            sessionEvent?.text === "started" ? sessionEvent.sessionId : null,
          selection: this.modelSelection.get() ?? null,
          queueDepth: queue.filter((m) => m.status === "queued").length,
          inFlight: queue.find((m) => m.status === "in-flight")?.id ?? null,
          attached: this.attached,
          taskQueueDepth: this.tasks
            .snapshot()
            .filter((task) => ["queued", "retry-wait"].includes(task.state))
            .length,
          taskInFlight:
            this.tasks.snapshot().find((task) => task.state === "running")
              ?.id ?? null,
        });
        return;
      }
      res.writeHead(404).end("not found\n");
    } catch (error) {
      const status = error instanceof IntegralError ? error.exitCode : 500;
      json(res, status >= 400 && status < 600 ? status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private exclusiveWork<T>(work: () => Promise<T>): Promise<T> {
    const result = this.workChain.then(work, work);
    this.workChain = result.catch(() => undefined);
    return result;
  }
  private async submitMessage(text: string, terminalId: string) {
    const item = await this.queue.enqueue(text),
      event = await this.conversation.append({
        type: "user",
        messageId: item.id,
        text: item.text,
      });
    this.broadcast("conversation.user", { ...event, terminalId });
    return item;
  }
  private stream(req: IncomingMessage, res: ServerResponse): void {
    const attachmentId = randomUUID();
    this.attachments.add(attachmentId);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-integral-attachment-id": attachmentId,
    });
    this.attached++;
    this.broadcast("chat.attached", { attached: this.attached });
    // Snapshot and listener registration are synchronous, avoiding a snapshot-to-live gap.
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    const listener = (event: ClientEvent) =>
      res.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
      );
    this.events.on("event", listener);
    req.once("close", () => {
      this.events.off("event", listener);
      this.attachments.delete(attachmentId);
      this.attached--;
      this.broadcast("chat.detached", { attached: this.attached });
    });
  }
  async stop(): Promise<void> {
    if (this.catalogRefresh !== undefined) {
      this.dependencies.cancelDeferred(this.catalogRefresh);
      this.catalogRefresh = undefined;
    }
    this.dependencies.intervals.clearInterval(this.refreshTimer);
    this.attachments.clear();
    for (const waiter of this.approvalWaiters.values())
      waiter.reject(
        new IntegralError("coordinator stopped; approval remains pending", 503),
      );
    this.approvalWaiters.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await this.dependencies.servers.close(server);
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
    throw new IntegralError("invalid JSON request", 400);
  }
}
function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new IntegralError("expected an integer", 400);
  return value;
}
function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : numberValue(value);
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(value)}\n`);
}
function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: "unauthorized component request" });
}
