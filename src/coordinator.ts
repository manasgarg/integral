import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { EffectiveConfig } from "./config.ts";
import type { IntegralPaths } from "./paths.ts";
import {
  ConversationStore,
  DurableQueue,
  ModelSelectionStore,
} from "./queue.ts";
import {
  listModelChoices,
  matchModelChoices,
  sameSelection,
  type ModelCatalog,
  type ModelCatalogProgress,
  type ModelChoice,
  type ModelSelection,
} from "./model-selection.ts";
import {
  componentIdentity,
  deploymentId,
  readComponentState,
  updateComponentState,
  verifyInternal,
} from "./state.ts";
import { atomicWrite, readText } from "./fs.ts";
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
import type { ConversationOriginRoute } from "./schedule-types.ts";
import { DEFAULT_PI_IMAGE, type Component } from "./constants.ts";
import type { Logger } from "./logging.ts";
import { ensureContainerImage } from "./container.ts";
import { readJsonObject, writeJson } from "./http-server.ts";
import {
  ClientEventStream,
  type ClientEvent,
} from "./coordinator/event-stream.ts";
export type { ClientEvent } from "./coordinator/event-stream.ts";
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
import {
  activateImageProposal,
  buildImageRecipe,
  imageRecipeHead,
  imageRecipeTreeDigest,
  stageImageProposal,
  type ImageBuildResult,
  type ImageProposal,
} from "./image-recipe.ts";
import {
  clearConnectionDegraded,
  credentialFor,
  loadConnections,
  markConnectionDegraded,
} from "./connections.ts";
import {
  DiscordIngressStore,
  DiscordJsListener,
  type DiscordListener,
  type DiscordListenerCallbacks,
  type DiscordMessage,
} from "./discord.ts";

interface ConversationScope {
  id: string;
  queue: DurableQueue;
  conversation: ConversationStore;
  modelSelection: ModelSelectionStore;
  discord?: {
    listener: DiscordListener;
    ingress: DiscordIngressStore;
    userId: string;
    channelId: string;
  };
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
  stageImageProposal: typeof stageImageProposal;
  buildImageRecipe: typeof buildImageRecipe;
  activateImageProposal: typeof activateImageProposal;
  imageRecipeHead: typeof imageRecipeHead;
  imageRecipeTreeDigest: typeof imageRecipeTreeDigest;
  createDiscordListener(
    connection: import("./connections.ts").Connection,
    token: string,
    callbacks: DiscordListenerCallbacks,
  ): DiscordListener;
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
  stageImageProposal,
  buildImageRecipe,
  activateImageProposal,
  imageRecipeHead,
  imageRecipeTreeDigest,
  createDiscordListener: (connection, token, callbacks) =>
    new DiscordJsListener(connection, token, callbacks),
};
export class Coordinator {
  readonly queue: DurableQueue;
  readonly conversation: ConversationStore;
  readonly modelSelection: ModelSelectionStore;
  readonly tasks: DurableTaskQueue;
  readonly approvals: ApprovalStore;
  private readonly eventStream = new ClientEventStream();
  readonly events = this.eventStream.events;
  private server: http.Server | undefined;
  private readonly attachments = this.eventStream.attachments;
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
  private readonly scopes = new Map<string, ConversationScope>();
  private discordScope: ConversationScope | undefined;
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
    this.scopes.set("terminal", {
      id: "terminal",
      queue: this.queue,
      conversation: this.conversation,
      modelSelection: this.modelSelection,
    });
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
    await this.startDiscord().catch((error: unknown) =>
      this.logger?.event(
        "warn",
        "discord.start_failed",
        error instanceof Error ? error.message : String(error),
      ),
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
  private async startDiscord(): Promise<void> {
    const loaded = await loadConnections(this.paths);
    const connections = loaded.connections.filter(
      (connection) =>
        connection.kind === "channel" && connection.provider === "discord",
    );
    if (connections.length > 1)
      throw new IntegralError(
        "only one Discord channel connection may be active",
      );
    const connection = connections[0];
    if (!connection?.channelId) return;
    const token = (await credentialFor(this.paths, connection.name))?.trim();
    if (!token) return;
    const directory = join(
        this.paths.channels,
        `discord-${connection.channelId}`,
      ),
      scope: ConversationScope = {
        id: `discord:${connection.channelId}`,
        queue: new DurableQueue(join(directory, "queue.json")),
        conversation: new ConversationStore(
          join(directory, "conversation.jsonl"),
        ),
        modelSelection: new ModelSelectionStore(join(directory, "model.json")),
      },
      ingress = new DiscordIngressStore(join(directory, "ingress.json"));
    await Promise.all([
      scope.queue.load(),
      scope.conversation.load(),
      scope.modelSelection.load(),
      ingress.load(),
    ]);
    if (!scope.modelSelection.get() && this.modelSelection.get())
      await scope.modelSelection.set(this.modelSelection.get()!);
    const listener = this.dependencies.createDiscordListener(
      connection,
      token,
      {
        recoveryPosition: () => ingress.position(),
        accept: (message) => this.submitDiscord(scope, ingress, message),
        unsupported: async () => {
          await listener.reply("I can currently process text messages only.");
        },
        command: (name, subcommand, options) =>
          this.discordCommand(scope, name, subcommand, options),
        failure: (error) =>
          void markConnectionDegraded(this.paths, connection.name, "listener")
            .catch(() => undefined)
            .finally(() =>
              this.logger?.event(
                "warn",
                "discord.listener_failed",
                error.message,
              ),
            ),
      },
    );
    scope.discord = {
      listener,
      ingress,
      userId: connection.userId!,
      channelId: connection.channelId,
    };
    this.discordScope = scope;
    this.scopes.set(scope.id, scope);
    try {
      await listener.start();
      await clearConnectionDegraded(this.paths, connection.name);
    } catch (error) {
      await markConnectionDegraded(this.paths, connection.name, "listener");
      throw error;
    }
  }
  private async discordCommand(
    scope: ConversationScope,
    name: string,
    subcommand: string | undefined,
    options: Record<string, string>,
  ): Promise<string> {
    if (name === "help")
      return [
        "/help — show this help",
        "/status — show deployment and conversation status",
        "/model [search] — show or select the shared model",
        "/queue ls|edit|delete — manage queued conversation messages",
        "/approvals ls|show|approve|deny — manage all governed requests",
      ].join("\n");
    if (name === "status") {
      const selection = this.modelSelection.get(),
        [gateway, runner, scheduler] = await Promise.all([
          readComponentState(this.paths, "gateway"),
          readComponentState(this.paths, "runner"),
          readComponentState(this.paths, "scheduler"),
        ]),
        conversations = [...this.scopes.values()].map((candidate) => {
          const queue = candidate.queue.snapshot(),
            session = candidate.conversation
              .snapshot()
              .filter((event) => event.type === "session")
              .at(-1);
          return `${candidate.id}: ${queue.filter((item) => item.status === "queued").length} queued, ${queue.find((item) => item.status === "in-flight")?.id ?? "idle"}, session ${session?.text === "started" ? session.sessionId : "none"}`;
        });
      return [
        `Discord listener: connected`,
        `Gateway: ${gateway?.status ?? "unavailable"}; runner: ${runner?.status ?? "unavailable"}; scheduler: ${scheduler?.status ?? "unavailable"}`,
        `Model: ${selection ? `${selection.connection}/${selection.model}` : "not selected"}`,
        ...conversations,
        `Tasks: ${this.tasks.snapshot().filter((task) => !["completed", "failed", "cancelled"].includes(task.state)).length} active`,
      ].join("\n");
    }
    if (name === "model") {
      const catalog = await this.modelCatalog(),
        search = options.search?.trim(),
        matches = matchModelChoices(
          catalog.choices,
          search ? search.split(/\s+/) : [],
        );
      if (search && matches.length === 1) {
        await this.selectConversationModel(
          matches[0]!.connection,
          matches[0]!.model,
        );
        return `Selected ${matches[0]!.connection}/${matches[0]!.model}.`;
      }
      const current = this.modelSelection.get(),
        heading = current
          ? `Current: ${current.connection}/${current.model}`
          : "Current: not selected";
      if (!matches.length)
        return `${heading}\nNo models matched; narrow or change the search.`;
      return `${heading}\n${matches.map((choice) => `${choice.connection}/${choice.model}`).join("\n")}${search && matches.length > 1 ? "\nMore than one model matched; narrow the search." : ""}`;
    }
    if (name === "queue") {
      if (!subcommand || subcommand === "ls") {
        const items = [...this.scopes.values()].flatMap((candidate) =>
          candidate.queue
            .snapshot()
            .map((item) => ({ ...item, conversationId: candidate.id })),
        );
        return items.length
          ? items
              .map(
                (item) =>
                  `${item.conversationId}  ${item.id}  ${item.status}  ${item.text}`,
              )
              .join("\n")
          : "All conversation queues are empty.";
      }
      if (!options.id)
        throw new IntegralError("A queue message ID is required.");
      const owner = [...this.scopes.values()].find((candidate) =>
        candidate.queue.snapshot().some((item) => item.id === options.id),
      );
      if (!owner) throw new IntegralError("Queue message not found.", 404);
      if (subcommand === "edit") {
        if (!options.text)
          throw new IntegralError("Replacement text is required.");
        await owner.queue.edit(options.id, options.text);
        await owner.conversation.editUser(options.id, options.text);
        return `Updated queue message ${options.id}.`;
      }
      if (subcommand === "delete") {
        await owner.queue.delete(options.id);
        await owner.conversation.deleteUser(options.id);
        return `Deleted queue message ${options.id}.`;
      }
    }
    if (name === "approvals") {
      const approvals = this.approvals.snapshot(),
        render = (approval: PublicApproval) =>
          `${approval.id}  ${approval.status}  ${approval.summary}`;
      if (!subcommand || subcommand === "ls")
        return approvals.length
          ? approvals.map(render).join("\n")
          : "There are no approval requests.";
      if (!options.id) throw new IntegralError("An approval ID is required.");
      if (subcommand === "show")
        return render(publicApproval(this.approvals.get(options.id)));
      if (subcommand === "approve" || subcommand === "deny")
        return render(
          await this.decideApproval(
            options.id,
            subcommand === "approve" ? "approved" : "denied",
            "",
            false,
            `discord:${scope.discord!.userId}:${scope.discord!.channelId}`,
          ),
        );
    }
    throw new IntegralError("Unsupported Discord command.", 400);
  }
  private async deliverDiscord(
    scope: ConversationScope,
    text: string,
  ): Promise<boolean> {
    const listener = scope.discord?.listener;
    if (!listener) return false;
    await listener.typing(false).catch(() => undefined);
    try {
      await listener.reply(text);
      return true;
    } catch (error) {
      this.logger?.event(
        "warn",
        "discord.delivery_failed",
        error instanceof Error ? error.message : String(error),
        { conversation_id: scope.id },
      );
      return false;
    }
  }
  private async submitDiscord(
    scope: ConversationScope,
    ingress: DiscordIngressStore,
    message: DiscordMessage,
  ): Promise<boolean> {
    return this.exclusiveWork(async () => {
      if (ingress.has(message.id)) return false;
      const origin = {
          provider: "discord" as const,
          externalId: message.id,
          userId: message.userId,
          channelId: message.channelId,
        },
        item = await scope.queue.enqueue(message.text, undefined, origin),
        alreadyRecorded = scope.conversation
          .snapshot()
          .some((event) => event.origin?.externalId === message.id);
      if (!alreadyRecorded)
        await scope.conversation.append({
          type: "user",
          messageId: item.id,
          text: item.text,
          origin,
        });
      await ingress.record(message.id);
      await scope.discord?.listener.typing(true).catch(() => undefined);
      if (!scope.modelSelection.get()) {
        await this.deliverDiscord(
          scope,
          "Select a model with /model before I can process this message.",
        );
        return true;
      }
      if (
        scope.queue
          .snapshot()
          .some((candidate) => candidate.status === "in-flight")
      ) {
        await scope.queue.markSteering(item.id);
        const response = await this.dependencies
          .internalFetch(
            this.paths,
            "coordinator",
            "runner",
            "/integral/internal/steer",
            {
              method: "POST",
              body: JSON.stringify({
                conversationId: scope.id,
                messageId: item.id,
                text: item.text,
              }),
            },
          )
          .catch(() => undefined);
        if (!response?.ok) await scope.queue.release(item.id);
      }
      return true;
    });
  }
  private async refresh(): Promise<void> {
    await Promise.all([
      this.adoptGeneration(),
      this.adoptExternalModelSelection(),
      this.flushTaskOutbox(),
      this.expireApprovals(),
    ]);
  }
  private async adoptExternalModelSelection(): Promise<void> {
    const previous = this.modelSelection.get();
    await this.modelSelection.load();
    const current = this.modelSelection.get();
    if (!sameSelection(previous, current) && current) {
      await this.setSharedModelSelection(current);
      this.modelCatalogs.clear();
      this.modelCatalogLoads.clear();
      this.broadcast("conversation.selection", current);
    }
  }

  async flushTaskOutbox(): Promise<void> {
    for (const entry of this.tasks.outbox()) {
      if (entry.origin) {
        const scope = this.scopes.get(entry.origin.conversationId);
        if (scope?.discord) {
          const text = `Task ${entry.taskId ?? entry.executionId} ${entry.outcome}${entry.result ? `: ${entry.result}` : entry.error ? ": see /status for retry guidance" : "."}`;
          if (!(await this.deliverDiscord(scope, text))) continue;
          await scope.conversation.append({ type: "notification", text });
        }
      }
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
    return this.eventStream.broadcast(type, data);
  }
  private snapshot(
    scope: ConversationScope = this.scopes.get("terminal")!,
  ): Record<string, unknown> {
    return {
      deploymentId: deploymentId(this.paths),
      conversation: scope.conversation.snapshot(),
      queue: scope.queue.snapshot(),
      tasks: this.tasks.snapshot(),
      modelSelection: scope.modelSelection.get() ?? null,
      approvals: this.approvals.snapshot(),
      eventSequence: this.eventStream.sequence,
      attached: this.eventStream.attached,
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
      if (
        [...this.scopes.values()].some((scope) =>
          scope.queue.snapshot().some((item) => item.status === "in-flight"),
        )
      )
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
        await this.setSharedModelSelection(choice);
        this.broadcast("conversation.selection", choice);
      }
      return choice;
    });
  }
  private async setSharedModelSelection(
    selection: ModelSelection,
  ): Promise<void> {
    await Promise.all(
      [...this.scopes.values()].map((scope) =>
        scope.modelSelection.set(selection),
      ),
    );
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
      await this.setSharedModelSelection(updatedSelection);
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
      route?: ConversationOriginRoute;
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
        ...(input.route ? { route: input.route } : {}),
      });
      waiting = this.waitForApproval(record, input.sessionId, response);
      this.broadcast("approval.requested", publicApproval(record));
      await this.notifyDiscordApproval(record, "requested");
    });
    return waiting!;
  }

  async requestImageRecipeApproval(
    input: {
      operation: "proposal" | "rebuild";
      sessionId: string;
      runId?: string;
      route?: ConversationOriginRoute;
      proposed?: string;
      bundle?: Buffer;
    },
    response: ServerResponse,
  ): Promise<PublicApproval> {
    let waiting: Promise<PublicApproval> | undefined;
    await this.exclusiveWork(async () => {
      if (!input.sessionId.trim())
        throw new IntegralError("approval origin session is required", 400);
      if (this.config.runner.image !== DEFAULT_PI_IMAGE)
        throw new IntegralError(
          "image recipes can only change Integral's managed Pi image",
          409,
        );
      const selection = this.modelSelection.get();
      if (!selection)
        throw new IntegralError(
          "select a model before changing the Pi image",
          409,
        );
      let proposal: ImageProposal | undefined;
      if (input.operation === "proposal") {
        if (!input.bundle || !input.proposed)
          throw new IntegralError(
            "image proposal bundle and commit are required",
            400,
          );
        proposal = await this.dependencies.stageImageProposal(
          this.paths,
          input.bundle,
          input.proposed,
        );
      }
      const baseCommit =
          proposal?.baseCommit ??
          (await this.dependencies.imageRecipeHead(this.paths)),
        treeDigest =
          proposal?.treeDigest ??
          (await this.dependencies.imageRecipeTreeDigest(
            this.paths,
            baseCommit,
          )),
        record = await this.approvals.create({
          request: {
            kind: "image-recipe",
            operation: input.operation,
            baseCommit,
            ...(proposal
              ? {
                  proposedCommit: proposal.proposedCommit,
                  proposalRef: proposal.proposalRef,
                }
              : {}),
            treeDigest,
            changedPaths: proposal?.changedPaths ?? [],
            diff: proposal?.diff ?? "",
            priorImage: selection.piImage,
          },
          sessionId: input.sessionId,
          ...(input.runId ? { runId: input.runId } : {}),
          selection,
          ...(input.route ? { route: input.route } : {}),
        });
      waiting = this.waitForApproval(record, input.sessionId, response);
      this.broadcast("approval.requested", publicApproval(record));
      await this.notifyDiscordApproval(record, "requested");
    });
    return waiting!;
  }

  private waitForApproval(
    record: ApprovalRecord,
    sessionId: string,
    response: ServerResponse,
  ): Promise<PublicApproval> {
    return new Promise<PublicApproval>((resolve, reject) => {
      this.approvalWaiters.set(record.id, { sessionId, resolve, reject });
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
  }

  async decideApproval(
    id: string,
    outcome: "approved" | "denied",
    attachmentId: string,
    localOperator = false,
    trustedChannelActor?: string,
  ): Promise<PublicApproval> {
    if (
      !localOperator &&
      !trustedChannelActor &&
      !this.attachments.has(attachmentId)
    )
      throw new IntegralError(
        "approval requires an attached human terminal",
        403,
      );
    const decisionIdentity = localOperator
      ? "operator"
      : (trustedChannelActor ?? attachmentId);
    const existing = this.approvals.get(id);
    if (
      existing.status === "pending" &&
      Date.parse(existing.expiresAt) <= this.dependencies.now()
    ) {
      await this.expireApprovals();
      throw new IntegralError(`approval ${id} is already expired`, 409);
    }
    const decided = await this.exclusiveWork(() =>
      this.approvals.decide(id, outcome, decisionIdentity),
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
      const result =
        record.request.kind === "container-packages"
          ? await this.executePackageApproval(record, record.request)
          : await this.executeImageRecipeApproval(record, record.request);
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

  private async executePackageApproval(
    record: ApprovalRecord,
    request: Extract<ApprovalRecord["request"], { kind: "container-packages" }>,
  ): Promise<Record<string, unknown>> {
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
    return await this.changeContainerPackages({
      operation: request.operation,
      packages: request.packages,
      expectedRevision: request.expectedRevision,
      actor: `approval:${record.id}`,
      approvalId: record.id,
    });
  }

  private async executeImageRecipeApproval(
    record: ApprovalRecord,
    request: Extract<ApprovalRecord["request"], { kind: "image-recipe" }>,
  ): Promise<Record<string, unknown>> {
    const selectedCommit = request.proposedCommit ?? request.baseCommit,
      activeCommit = await this.dependencies.imageRecipeHead(this.paths),
      rawCheckpoint = await readText(this.paths.imageState);
    let checkpoint:
      { approvalId: string; result: ImageBuildResult } | undefined;
    if (rawCheckpoint)
      try {
        checkpoint = JSON.parse(rawCheckpoint) as {
          approvalId: string;
          result: ImageBuildResult;
        };
      } catch {
        throw new IntegralError("invalid managed image execution state");
      }
    if (
      activeCommit !== request.baseCommit &&
      activeCommit !== request.proposedCommit
    )
      throw new IntegralError(
        `image recipe approval is stale: active commit is ${activeCommit}`,
        409,
      );
    const selection = this.modelSelection.get();
    if (
      checkpoint?.approvalId !== record.id &&
      selection?.piImage !== request.priorImage
    )
      throw new IntegralError(
        "image recipe approval is stale because the selected image changed",
        409,
      );
    const result =
      checkpoint?.approvalId === record.id
        ? checkpoint.result
        : await this.dependencies.buildImageRecipe(
            this.paths,
            this.config,
            selectedCommit,
            `approval:${record.id}`,
            { priorImage: request.priorImage, approvalId: record.id },
          );
    if (checkpoint?.approvalId !== record.id)
      await atomicWrite(
        this.paths.imageState,
        `${JSON.stringify({ approvalId: record.id, result })}\n`,
      );
    if (request.operation === "proposal" && activeCommit === request.baseCommit)
      await this.dependencies.activateImageProposal(this.paths, {
        baseCommit: request.baseCommit,
        proposedCommit: request.proposedCommit!,
        proposalRef: request.proposalRef!,
        treeDigest: request.treeDigest,
        changedPaths: request.changedPaths,
        diff: request.diff,
      });
    await atomicWrite(
      this.paths.activeImage,
      `${JSON.stringify({ schemaVersion: 1, recipeCommit: selectedCommit, result })}\n`,
    );
    if (!selection)
      throw new IntegralError("selected model is unavailable", 409);
    const updated = {
      ...selection,
      piVersion: result.piVersion,
      piImage: result.image,
    };
    await this.setSharedModelSelection(updated);
    this.modelCatalogs.clear();
    this.modelCatalogLoads.clear();
    this.broadcast("conversation.selection", updated);
    return {
      recipeCommit: result.recipeCommit,
      piVersion: result.piVersion,
      piImage: result.image,
      packages: result.packages,
    };
  }

  private async expireApprovals(): Promise<void> {
    for (const record of await this.approvals.expireDue()) {
      this.broadcast("approval.resolved", publicApproval(record));
      await this.deliverApproval(record);
    }
  }

  private async deliverApproval(record: ApprovalRecord): Promise<void> {
    if (!isTerminalApproval(record)) return;
    await this.notifyDiscordApproval(record, record.status);
    const waiter = this.approvalWaiters.get(record.id);
    if (waiter) {
      this.approvalWaiters.delete(record.id);
      waiter.resolve(publicApproval(record));
      return;
    }
    await this.ensureApprovalContinuation(record);
  }

  private async notifyDiscordApproval(
    record: ApprovalRecord,
    state: "requested" | TerminalApprovalStatus,
  ): Promise<void> {
    const route = record.origin.route;
    if (!route) return;
    const scope = this.scopes.get(route.conversationId);
    if (
      !scope?.discord ||
      scope.discord.userId !== route.userId ||
      scope.discord.channelId !== route.channelId
    )
      return;
    const text =
      state === "requested"
        ? `Approval ${record.id} requested: ${record.summary}. Deadline ${record.expiresAt}. Use /approvals show, /approvals approve, or /approvals deny.`
        : `Approval ${record.id} is ${state}.`;
    if (await this.deliverDiscord(scope, text))
      await scope.conversation.append({ type: "notification", text });
  }

  private async ensureApprovalContinuation(
    record: ApprovalRecord & { status: TerminalApprovalStatus },
  ): Promise<void> {
    if (record.continuationMessageId) return;
    const route = record.origin.route,
      scope = route
        ? this.scopes.get(route.conversationId)
        : this.scopes.get("terminal"),
      existing = scope?.queue
        .snapshot()
        .find((item) => item.approvalContinuation?.approvalId === record.id);
    if (existing) {
      await this.approvals.setContinuation(record.id, existing.id);
      return;
    }
    if (!scope) return;
    const detail = record.execution?.result
        ? JSON.stringify(record.execution.result)
        : (record.execution?.error ?? record.status),
      text = `Approval ${record.id} for ${record.summary} resolved as ${record.status}. Outcome: ${detail}. This continues session ${record.origin.sessionId}${record.origin.runId ? ` and run ${record.origin.runId}` : ""}. Review the outcome and continue the conversation.`,
      item = await scope.queue.enqueue(
        text,
        {
          approvalId: record.id,
          originSessionId: record.origin.sessionId,
          ...(record.origin.runId ? { originRunId: record.origin.runId } : {}),
          outcome: record.status,
          summary: record.summary,
        },
        route
          ? {
              provider: "discord",
              externalId: `approval:${record.id}`,
              userId: route.userId,
              channelId: route.channelId,
            }
          : undefined,
      );
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
        const conversationId = url.searchParams.get("conversationId");
        if (conversationId && !this.internal(req, "gateway"))
          return unauthorized(res);
        const scope = conversationId
          ? this.scopes.get(conversationId)
          : this.scopes.get("terminal");
        if (!scope) throw new IntegralError("unknown conversation", 404);
        json(res, 200, this.snapshot(scope));
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
              ...(body.origin
                ? { route: conversationOrigin(body.origin) }
                : {}),
            },
            res,
          );
          json(res, 200, approval);
          return;
        }
        throw new IntegralError("unsupported package operation", 405);
      }
      if (url.pathname === "/integral/internal/image-recipe") {
        if (!this.internal(req, "gateway")) return unauthorized(res);
        if (req.method !== "POST")
          throw new IntegralError("unsupported image recipe operation", 405);
        const body = await bodyJson(req, 45 * 1024 * 1024),
          operation = stringValue(body.operation);
        if (operation !== "proposal" && operation !== "rebuild")
          throw new IntegralError("invalid image recipe operation", 400);
        const encoded = stringValue(body.bundle),
          approval = await this.requestImageRecipeApproval(
            {
              operation,
              sessionId: stringValue(body.originSessionId),
              ...(stringValue(body.originRunId)
                ? { runId: stringValue(body.originRunId) }
                : {}),
              ...(body.origin
                ? { route: conversationOrigin(body.origin) }
                : {}),
              ...(operation === "proposal"
                ? {
                    proposed: stringValue(body.proposed),
                    bundle: Buffer.from(encoded, "base64"),
                  }
                : {}),
            },
            res,
          );
        json(res, 200, approval);
        return;
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
        const localOperator = stringValue(body.actor) === "operator";
        json(
          res,
          200,
          await this.decideApproval(
            approvalDecision[1]!,
            approvalDecision[2] === "approve" ? "approved" : "denied",
            stringValue(body.attachmentId),
            localOperator,
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
        const result = await this.exclusiveWork(async () => {
          for (const scope of this.scopes.values()) {
            const selection = scope.modelSelection.get();
            if (!selection) continue;
            const item = await scope.queue.claim();
            if (item) return { item, selection, scope };
          }
          const scope = this.scopes.get("terminal")!;
          return { item: undefined, selection: undefined, scope };
        });
        json(res, 200, {
          message: result.item,
          selection: result.selection ?? null,
          conversationId: result.scope.id,
          context: result.scope.conversation.context(
            this.config.conversation.contextMaxMessages,
            this.config.conversation.contextMaxChars,
          ),
        });
        return;
      }
      if (
        url.pathname === "/integral/internal/channel-notification" &&
        req.method === "POST"
      ) {
        if (!this.internal(req, "gateway")) return unauthorized(res);
        const body = await bodyJson(req),
          scope = this.scopes.get(stringValue(body.conversationId));
        if (
          !scope?.discord ||
          scope.discord.userId !== stringValue(body.userId) ||
          scope.discord.channelId !== stringValue(body.channelId)
        )
          throw new IntegralError(
            "unknown conversation notification route",
            404,
          );
        const text = stringValue(body.text);
        if (!text)
          throw new IntegralError("notification text is required", 400);
        if (!(await this.deliverDiscord(scope, text)))
          throw new IntegralError("Discord notification delivery failed", 503);
        await scope.conversation.append({ type: "notification", text });
        res.writeHead(204).end();
        return;
      }
      if (
        url.pathname === "/integral/internal/session" &&
        req.method === "POST"
      ) {
        if (!this.internal(req)) return unauthorized(res);
        const body = await bodyJson(req),
          sessionId = stringValue(body.sessionId),
          state = stringValue(body.state),
          scope = this.scopes.get(stringValue(body.conversationId, "terminal"));
        if (!sessionId || !["started", "ended"].includes(state))
          throw new IntegralError("invalid session event", 400);
        if (!scope) throw new IntegralError("unknown conversation", 404);
        const event = await scope.conversation.append({
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
        if (scope.id === "terminal")
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
        const scope = this.scopes.get(
          stringValue(body.conversationId, "terminal"),
        );
        if (!scope) throw new IntegralError("unknown conversation", 404);
        if (action === "complete") {
          const event = await scope.conversation.append({
            type: "assistant",
            messageId: id!,
            text: stringValue(body.text),
          });
          await scope.queue.complete(id!);
          const steered = Array.isArray(body.steeredMessageIds)
            ? body.steeredMessageIds.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          for (const steeredId of steered)
            await scope.queue.complete(steeredId);
          if (scope.id === "terminal")
            this.broadcast("conversation.assistant", event);
          else await this.deliverDiscord(scope, event.text ?? "");
        } else {
          await scope.queue.release(
            id!,
            stringValue(body.reason, "interrupted"),
          );
          const steered = Array.isArray(body.steeredMessageIds)
            ? body.steeredMessageIds.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          for (const steeredId of steered) await scope.queue.release(steeredId);
          const event = await scope.conversation.append({
            type: "error",
            messageId: id!,
            text: stringValue(body.reason, "turn interrupted"),
          });
          if (scope.id === "terminal")
            this.broadcast("conversation.error", event);
          else
            await this.deliverDiscord(
              scope,
              "I couldn't complete that request. It remains queued when retrying is safe; check /status and try again.",
            );
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
          attached: this.eventStream.attached,
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
    this.eventStream.attach(req, res, () => this.snapshot());
  }
  async stop(): Promise<void> {
    if (this.catalogRefresh !== undefined) {
      this.dependencies.cancelDeferred(this.catalogRefresh);
      this.catalogRefresh = undefined;
    }
    this.dependencies.intervals.clearInterval(this.refreshTimer);
    this.eventStream.clear();
    for (const waiter of this.approvalWaiters.values())
      waiter.reject(
        new IntegralError("coordinator stopped; approval remains pending", 503),
      );
    this.approvalWaiters.clear();
    await this.discordScope?.discord?.listener.stop();
    const server = this.server;
    this.server = undefined;
    if (server) await this.dependencies.servers.close(server);
  }
}

async function bodyJson(
  req: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  return await readJsonObject(req, { maxBytes });
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
function conversationOrigin(value: unknown): ConversationOriginRoute {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IntegralError("invalid conversation origin", 400);
  const origin = value as Record<string, unknown>;
  if (origin.provider !== "discord")
    throw new IntegralError("unsupported conversation origin", 400);
  return {
    provider: "discord",
    conversationId: stringValue(origin.conversationId),
    externalId: stringValue(origin.externalId),
    userId: stringValue(origin.userId),
    channelId: stringValue(origin.channelId),
  };
}
function json(res: ServerResponse, status: number, value: unknown): void {
  writeJson(res, status, value);
}
function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: "unauthorized component request" });
}
