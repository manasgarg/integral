import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import type { EffectiveConfig } from "./config.ts";
import type { RrPaths } from "./paths.ts";
import { ConversationStore, DurableQueue, type QueueEvent } from "./queue.ts";
import { componentIdentity, deploymentId, readComponentState, updateComponentState, verifyInternal } from "./state.ts";
import { readText } from "./fs.ts";
import { join } from "node:path";
import type { Logger } from "./logging.ts";
import { RrError } from "./errors.ts";

export interface ClientEvent { sequence: number; type: string; data: unknown }
export class Coordinator {
  readonly queue: DurableQueue; readonly conversation: ConversationStore; private readonly events = new EventEmitter(); private server: http.Server | undefined; private eventSequence = 0; private attached = 0; private token = ""; private refreshTimer: NodeJS.Timeout | undefined;
  constructor(private readonly paths: RrPaths, private readonly config: EffectiveConfig, private readonly logger: Logger) {
    this.queue = new DurableQueue(paths.queue, (event) => this.broadcast(`queue.${event.type}`, event)); this.conversation = new ConversationStore(paths.conversation);
  }
  async start(): Promise<http.Server> {
    await this.queue.load(); await this.conversation.load(); this.token = await componentIdentity(this.paths);
    const server = http.createServer((req, res) => void this.route(req, res)); this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.config.server.coordinatorPort, "127.0.0.1", resolve); }); this.refreshTimer = setInterval(() => void this.adoptGeneration(), 500); return server;
  }
  private async adoptGeneration(): Promise<void> { const generation = Number((await readText(join(this.paths.state, "connection-generation")))?.trim() || "0"); await updateComponentState(this.paths, "coordinator", { connectionGeneration: generation, status: "ready" }); }
  private broadcast(type: string, data: unknown): ClientEvent { const event = { sequence: ++this.eventSequence, type, data }; this.events.emit("event", event); return event; }
  private snapshot(): Record<string, unknown> { return { deploymentId: deploymentId(this.paths), conversation: this.conversation.snapshot(), queue: this.queue.snapshot(), eventSequence: this.eventSequence, attached: this.attached }; }
  private internal(req: IncomingMessage): boolean { return verifyInternal(req.headers, "runner", this.token, deploymentId(this.paths)); }
  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://coordinator");
      if (url.pathname === "/rr/health" && req.method === "GET") { const [gateway, runner] = await Promise.all([readComponentState(this.paths, "gateway"), readComponentState(this.paths, "runner")]); json(res, 200, { component: "coordinator", deploymentId: deploymentId(this.paths), status: gateway?.status === "ready" && runner?.status === "ready" ? "ready" : "degraded", dependencies: { gateway: gateway?.status ?? "unavailable", runner: runner?.status ?? "unavailable" } }); return; }
      if (url.pathname === "/rr/snapshot" && req.method === "GET") { json(res, 200, this.snapshot()); return; }
      if (url.pathname === "/rr/events" && req.method === "GET") { this.stream(req, res); return; }
      if (url.pathname === "/rr/messages" && req.method === "POST") {
        const body = await bodyJson(req), text = String(body.text ?? ""); const item = await this.queue.enqueue(text);
        const event = await this.conversation.append({ type: "user", messageId: item.id, text: item.text }); this.broadcast("conversation.user", event); json(res, 201, item); return;
      }
      const queueMatch = url.pathname.match(/^\/rr\/queue\/([^/]+)$/);
      if (queueMatch && req.method === "PATCH") { const body = await bodyJson(req), item = await this.queue.edit(queueMatch[1]!, String(body.text ?? "")); await this.conversation.editUser(item.id, item.text); json(res, 200, item); return; }
      if (queueMatch && req.method === "DELETE") { await this.queue.delete(queueMatch[1]!); await this.conversation.deleteUser(queueMatch[1]!); res.writeHead(204).end(); return; }
      if (url.pathname === "/rr/internal/claim" && req.method === "POST") {
        if (!this.internal(req)) return unauthorized(res); const item = await this.queue.claim();
        json(res, 200, { message: item, context: this.conversation.context(this.config.conversation.contextMaxMessages, this.config.conversation.contextMaxChars) }); return;
      }
      if (url.pathname === "/rr/internal/session" && req.method === "POST") { if (!this.internal(req)) return unauthorized(res); const body = await bodyJson(req), sessionId = String(body.sessionId ?? ""), state = String(body.state ?? ""); if (!sessionId || !["started", "ended"].includes(state)) throw new RrError("invalid session event", 400); const event = await this.conversation.append({ type: "session", sessionId, text: state }); this.broadcast("conversation.session", event); res.writeHead(204).end(); return; }
      const workMatch = url.pathname.match(/^\/rr\/internal\/work\/([^/]+)\/(complete|release)$/);
      if (workMatch && req.method === "POST") {
        if (!this.internal(req)) return unauthorized(res); const [_, id, action] = workMatch; const body = await bodyJson(req);
        if (action === "complete") { const event = await this.conversation.append({ type: "assistant", messageId: id!, text: String(body.text ?? "") }); await this.queue.complete(id!); this.broadcast("conversation.assistant", event); }
        else { await this.queue.release(id!, String(body.reason ?? "interrupted")); const event = await this.conversation.append({ type: "error", messageId: id!, text: String(body.reason ?? "turn interrupted") }); this.broadcast("conversation.error", event); }
        res.writeHead(204).end(); return;
      }
      if (url.pathname === "/rr/status" && req.method === "GET") {
        const [gateway, runner] = await Promise.all([readComponentState(this.paths, "gateway"), readComponentState(this.paths, "runner")]); const queue = this.queue.snapshot();
        const sessionEvent = this.conversation.snapshot().filter((e) => e.type === "session").at(-1); json(res, 200, { gateway: gateway?.status ?? "unavailable", runner: runner?.status ?? "unavailable", container: sessionEvent?.text === "started" ? "healthy" : "stopped", session: sessionEvent?.text === "started" ? sessionEvent.sessionId : null, provider: this.config.model.connection ?? "auto", queueDepth: queue.filter((m) => m.status === "queued").length, inFlight: queue.find((m) => m.status === "in-flight")?.id ?? null, attached: this.attached }); return;
      }
      res.writeHead(404).end("not found\n");
    } catch (error) { const status = error instanceof RrError ? error.exitCode : 500; json(res, status >= 400 && status < 600 ? status : 500, { error: error instanceof Error ? error.message : String(error) }); }
  }
  private stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); this.attached++; this.broadcast("chat.attached", { attached: this.attached });
    // Snapshot and listener registration are synchronous, avoiding a snapshot-to-live gap.
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    const listener = (event: ClientEvent) => res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`); this.events.on("event", listener);
    req.once("close", () => { this.events.off("event", listener); this.attached--; this.broadcast("chat.detached", { attached: this.attached }); });
  }
  async stop(): Promise<void> { clearInterval(this.refreshTimer); const server = this.server; this.server = undefined; if (server) await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); try { return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>; } catch { throw new RrError("invalid JSON request", 400); } }
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "content-type": "application/json" }); res.end(`${JSON.stringify(value)}\n`); }
function unauthorized(res: ServerResponse): void { json(res, 401, { error: "unauthorized component request" }); }
