import http from "node:http";
import { readFile } from "node:fs/promises";
import type { EffectiveConfig } from "./config.ts";
import { listConnections, type Connection } from "./connections.ts";
import type { RrPaths } from "./paths.ts";
import type { Logger } from "./logging.ts";
import { buildContainerSpec, createLockedNetwork, dockerAvailable, dockerNetworkGateway, freshSessionHome, newSessionIdentity, PiContainer } from "./container.ts";
import { ensureCa } from "./ca.ts";
import { componentEndpoint, internalFetch } from "./http-client.ts";
import { deploymentId } from "./state.ts";
import { RrError } from "./errors.ts";
import type { ConversationEvent, QueuedMessage } from "./queue.ts";

export class Runner {
  private server: http.Server | undefined; private pi: PiContainer | undefined; private stopped = false; private polling: NodeJS.Timeout | undefined; private busy = false; private idle: NodeJS.Timeout | undefined;
  constructor(private readonly paths: RrPaths, private readonly config: EffectiveConfig, private readonly logger: Logger) {}
  async start(): Promise<http.Server> {
    const connections = await listConnections(this.paths); selectModel(connections, this.config); if (!dockerAvailable()) throw new RrError("Docker daemon is unavailable");
    const network = `rr-${deploymentId(this.paths)}`; await createLockedNetwork(network);
    const address = dockerNetworkGateway(network); await internalFetch(this.paths, "runner", "gateway", "/rr/internal/docker-listener", { method: "POST", body: JSON.stringify({ address }) }).catch(() => undefined);
    const server = http.createServer((req, res) => { if (req.url === "/rr/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ component: "runner", deploymentId: deploymentId(this.paths), status: "ready", session: this.pi?.spec.sessionId ?? null })); } else res.writeHead(404).end(); }); this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.config.server.runnerPort, "127.0.0.1", resolve); }); this.schedule(0); return server;
  }
  private schedule(ms = 500): void { if (!this.stopped) this.polling = setTimeout(() => void this.poll(), ms); }
  private async poll(): Promise<void> {
    if (this.busy || this.stopped) return this.schedule(); this.busy = true;
    let item: QueuedMessage | undefined;
    try {
      const gateway = await fetch(new URL("/rr/health", await componentEndpoint(this.paths, "gateway"))); if (!gateway.ok) throw new RrError("gateway unavailable");
      const response = await internalFetch(this.paths, "runner", "coordinator", "/rr/internal/claim", { method: "POST", body: "{}" }); if (!response.ok) throw new RrError(`claim failed: ${response.status}`);
      const body = await response.json() as { message?: QueuedMessage; context: ConversationEvent[] }; item = body.message; if (!item) { this.armIdle(); return; }
      clearTimeout(this.idle); await this.ensurePi(body.context); const answer = await this.pi!.prompt(item.text);
      await internalFetch(this.paths, "runner", "coordinator", `/rr/internal/work/${item.id}/complete`, { method: "POST", body: JSON.stringify({ text: answer }) });
    } catch (error) {
      if (item) await internalFetch(this.paths, "runner", "coordinator", `/rr/internal/work/${item.id}/release`, { method: "POST", body: JSON.stringify({ reason: error instanceof Error ? error.message : String(error) }) }).catch(() => undefined);
      if (this.pi && /gateway|container|timed out|exited/i.test(error instanceof Error ? error.message : String(error))) await this.destroyPi();
      const context = item ? { message_id: item.id, ...(this.pi ? { session_id: this.pi.spec.sessionId } : {}) } : {}; this.logger.event("warn", "runner.turn_failed", error instanceof Error ? error.message : String(error), context);
    } finally { this.busy = false; this.schedule(); }
  }
  private async ensurePi(context: ConversationEvent[]): Promise<void> {
    if (this.pi) return; const all = await listConnections(this.paths), model = selectModel(all, this.config), mcp = all.filter((c) => c.kind === "mcp"); const identity = newSessionIdentity(), ca = await ensureCa(this.paths), home = await freshSessionHome();
    const gatewayUrl = new URL(await componentEndpoint(this.paths, "gateway")); gatewayUrl.hostname = "host.rr.internal";
    const spec = buildContainerSpec({ config: this.config, gatewayUrl: gatewayUrl.toString(), caCert: ca.cert, caBundle: ca.bundle, sessionHome: home, ...identity, model, mcp });
    if (context.length) spec.args.push("--append-system-prompt", renderContext(context));
    await internalFetch(this.paths, "runner", "gateway", "/rr/internal/session", { method: "POST", body: JSON.stringify({ token: identity.sessionToken, sessionId: identity.sessionId }) });
    const pi = new PiContainer(spec, this.config, `rr-${deploymentId(this.paths)}`, (line) => this.logger.event("debug", "pi.stderr", line, { session_id: identity.sessionId }));
    try { await pi.start(); this.pi = pi; } catch (error) { await this.revoke(identity.sessionToken); await pi.stop(); throw error; }
  }
  private armIdle(): void { if (!this.pi || this.idle) return; this.idle = setTimeout(() => void this.destroyPi(), this.config.runner.idleTimeoutSeconds * 1000); }
  private async revoke(token: string): Promise<void> { await internalFetch(this.paths, "runner", "gateway", "/rr/internal/session", { method: "DELETE", body: JSON.stringify({ token }) }).catch(() => undefined); }
  private async destroyPi(): Promise<void> { clearTimeout(this.idle); this.idle = undefined; const pi = this.pi; this.pi = undefined; if (pi) { await this.revoke(pi.spec.sessionToken); await pi.stop(); } }
  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.polling); await this.destroyPi(); const server = this.server; if (server) await new Promise<void>((resolve) => server.close(() => resolve())); }
}

export function selectModel(connections: Connection[], config: EffectiveConfig): Connection {
  const active = connections.filter((c) => c.kind === "model" && "state" in c && c.state === "active");
  if (config.model.connection) { const selected = active.find((c) => c.name === config.model.connection); if (!selected) throw new RrError(`selected model connection ${config.model.connection} is absent, disabled, or not a model connection`); return selected; }
  if (active.length === 1) return active[0]!; if (active.length === 0) throw new RrError("no active model connection; run rr connection add");
  throw new RrError("multiple model connections are active; select one with [model].connection");
}
export function renderContext(events: ConversationEvent[]): string { return `Continue this durable conversation. Prior messages:\n${events.filter((e) => e.text).map((e) => `${e.type}: ${e.text}`).join("\n")}`; }
