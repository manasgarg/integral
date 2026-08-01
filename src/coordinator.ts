import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import type { EffectiveConfig } from "./config.ts";
import type { RrPaths } from "./paths.ts";
import {
  ConversationStore,
  DurableQueue,
  ModelSelectionStore,
} from "./queue.ts";
import {
  listModelChoices,
  sameSelection,
  type ModelCatalog,
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
import { RrError } from "./errors.ts";
import {
  nodeHttpServerRuntime,
  nodeIntervalRuntime,
  type HttpServerRuntime,
  type IntervalRuntime,
} from "./runtime.ts";

export interface ClientEvent {
  sequence: number;
  type: string;
  data: unknown;
}
export interface CoordinatorDependencies {
  servers: HttpServerRuntime;
  intervals: IntervalRuntime;
  listModelChoices(
    paths: RrPaths,
    config: EffectiveConfig,
  ): Promise<ModelCatalog>;
}
const productionDependencies: CoordinatorDependencies = {
  servers: nodeHttpServerRuntime,
  intervals: nodeIntervalRuntime,
  listModelChoices,
};
export class Coordinator {
  readonly queue: DurableQueue;
  readonly conversation: ConversationStore;
  readonly modelSelection: ModelSelectionStore;
  private readonly events = new EventEmitter();
  private server: http.Server | undefined;
  private eventSequence = 0;
  private attached = 0;
  private token = "";
  private refreshTimer: unknown;
  private workChain: Promise<unknown> = Promise.resolve();
  private readonly dependencies: CoordinatorDependencies;
  constructor(
    private readonly paths: RrPaths,
    private readonly config: EffectiveConfig,
    overrides: Partial<CoordinatorDependencies> = {},
  ) {
    this.dependencies = { ...productionDependencies, ...overrides };
    this.queue = new DurableQueue(paths.queue, (event) =>
      this.broadcast(`queue.${event.type}`, event),
    );
    this.conversation = new ConversationStore(paths.conversation);
    this.modelSelection = new ModelSelectionStore(paths.modelSelection);
  }
  async start(): Promise<http.Server> {
    await this.queue.load();
    await this.conversation.load();
    await this.modelSelection.load();
    this.token = await componentIdentity(this.paths);
    const server = http.createServer((req, res) => void this.route(req, res));
    this.server = server;
    await this.dependencies.servers.listen(
      server,
      this.config.server.coordinatorPort,
      "127.0.0.1",
    );
    this.refreshTimer = this.dependencies.intervals.setInterval(
      () => void this.adoptGeneration(),
      500,
    );
    return server;
  }
  private async adoptGeneration(): Promise<void> {
    const generation = Number(
      (
        await readText(join(this.paths.state, "connection-generation"))
      )?.trim() || "0",
    );
    await updateComponentState(this.paths, "coordinator", {
      connectionGeneration: generation,
      status: "ready",
    });
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
      modelSelection: this.modelSelection.get() ?? null,
      eventSequence: this.eventSequence,
      attached: this.attached,
    };
  }
  private internal(req: IncomingMessage): boolean {
    return verifyInternal(
      req.headers,
      "runner",
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
    const catalog = await this.dependencies.listModelChoices(
      this.paths,
      this.config,
    );
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
        throw new RrError(
          "cannot change model selection while a Pi turn is in flight",
          409,
        );
      const catalog = await this.dependencies.listModelChoices(
          this.paths,
          this.config,
        ),
        choice = catalog.choices.find(
          (candidate) =>
            candidate.connection === connection && candidate.model === model,
        );
      if (!choice)
        throw new RrError(
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
  private async route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://coordinator");
      if (url.pathname === "/rr/health" && req.method === "GET") {
        const [gateway, runner] = await Promise.all([
          readComponentState(this.paths, "gateway"),
          readComponentState(this.paths, "runner"),
        ]);
        json(res, 200, {
          component: "coordinator",
          deploymentId: deploymentId(this.paths),
          status:
            gateway?.status === "ready" && runner?.status === "ready"
              ? "ready"
              : "degraded",
          dependencies: {
            gateway: gateway?.status ?? "unavailable",
            runner: runner?.status ?? "unavailable",
          },
        });
        return;
      }
      if (url.pathname === "/rr/snapshot" && req.method === "GET") {
        json(res, 200, this.snapshot());
        return;
      }
      if (url.pathname === "/rr/events" && req.method === "GET") {
        this.stream(req, res);
        return;
      }
      if (url.pathname === "/rr/models" && req.method === "GET") {
        json(res, 200, await this.modelMenu());
        return;
      }
      if (url.pathname === "/rr/selection" && req.method === "PUT") {
        const body = await bodyJson(req),
          connection = stringValue(body.connection),
          model = stringValue(body.model);
        const selection = await this.selectConversationModel(connection, model);
        json(res, 200, selection);
        return;
      }
      if (url.pathname === "/rr/messages" && req.method === "POST") {
        if (!this.modelSelection.get())
          throw new RrError("select a model before submitting a message", 409);
        const body = await bodyJson(req),
          text = stringValue(body.text);
        const item = await this.queue.enqueue(text);
        const event = await this.conversation.append({
          type: "user",
          messageId: item.id,
          text: item.text,
        });
        this.broadcast("conversation.user", event);
        json(res, 201, item);
        return;
      }
      const queueMatch = url.pathname.match(/^\/rr\/queue\/([^/]+)$/);
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
      if (url.pathname === "/rr/internal/claim" && req.method === "POST") {
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
      if (url.pathname === "/rr/internal/session" && req.method === "POST") {
        if (!this.internal(req)) return unauthorized(res);
        const body = await bodyJson(req),
          sessionId = stringValue(body.sessionId),
          state = stringValue(body.state);
        if (!sessionId || !["started", "ended"].includes(state))
          throw new RrError("invalid session event", 400);
        const event = await this.conversation.append({
          type: "session",
          sessionId,
          text: state,
        });
        this.broadcast("conversation.session", event);
        res.writeHead(204).end();
        return;
      }
      const workMatch = url.pathname.match(
        /^\/rr\/internal\/work\/([^/]+)\/(complete|release)$/,
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
      if (url.pathname === "/rr/status" && req.method === "GET") {
        const [gateway, runner] = await Promise.all([
          readComponentState(this.paths, "gateway"),
          readComponentState(this.paths, "runner"),
        ]);
        const queue = this.queue.snapshot();
        const sessionEvent = this.conversation
          .snapshot()
          .filter((e) => e.type === "session")
          .at(-1);
        json(res, 200, {
          gateway: gateway?.status ?? "unavailable",
          runner: runner?.status ?? "unavailable",
          container: sessionEvent?.text === "started" ? "healthy" : "stopped",
          session:
            sessionEvent?.text === "started" ? sessionEvent.sessionId : null,
          selection: this.modelSelection.get() ?? null,
          queueDepth: queue.filter((m) => m.status === "queued").length,
          inFlight: queue.find((m) => m.status === "in-flight")?.id ?? null,
          attached: this.attached,
        });
        return;
      }
      res.writeHead(404).end("not found\n");
    } catch (error) {
      const status = error instanceof RrError ? error.exitCode : 500;
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
  private stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
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
      this.attached--;
      this.broadcast("chat.detached", { attached: this.attached });
    });
  }
  async stop(): Promise<void> {
    this.dependencies.intervals.clearInterval(this.refreshTimer);
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
    throw new RrError("invalid JSON request", 400);
  }
}
function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(value)}\n`);
}
function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: "unauthorized component request" });
}
