import { randomUUID } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import { RrError } from "./errors.ts";

export type QueueStatus = "queued" | "in-flight";
export interface QueuedMessage { id: string; text: string; order: number; status: QueueStatus; attempts: number; createdAt: string }
interface QueueFile { nextOrder: number; items: QueuedMessage[] }

export class DurableQueue {
  private data: QueueFile = { nextOrder: 1, items: [] };
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly onChange: (event: QueueEvent) => void = () => undefined) {}
  async load(): Promise<void> {
    const raw = await readText(this.file);
    if (!raw) return;
    const parsed = JSON.parse(raw) as QueueFile;
    if (!Number.isSafeInteger(parsed.nextOrder) || !Array.isArray(parsed.items)) throw new RrError(`invalid queue file: ${this.file}`);
    this.data = parsed;
    for (const item of this.data.items) if (item.status === "in-flight") item.status = "queued";
    await this.persist();
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work); this.chain = result.catch(() => undefined); return result;
  }
  private async persist(): Promise<void> { await atomicWrite(this.file, `${JSON.stringify(this.data)}\n`); }
  snapshot(): QueuedMessage[] { return this.data.items.map((item) => ({ ...item })).sort((a, b) => a.order - b.order); }
  async enqueue(text: string): Promise<QueuedMessage> { return this.exclusive(async () => {
    if (!text.trim()) throw new RrError("message must not be empty");
    const item: QueuedMessage = { id: randomUUID(), text, order: this.data.nextOrder++, status: "queued", attempts: 0, createdAt: new Date().toISOString() };
    this.data.items.push(item); try { await this.persist(); } catch (error) { this.data.items.pop(); this.data.nextOrder--; throw error; } this.onChange({ type: "queued", message: { ...item } }); return { ...item };
  }); }
  async edit(id: string, text: string): Promise<QueuedMessage> { return this.exclusive(async () => {
    if (!text.trim()) throw new RrError("message must not be empty");
    const item = this.find(id); if (item.status === "in-flight") throw new RrError(`message ${id} is in flight`);
    const previous = item.text; item.text = text;
    try { await this.persist(); } catch (error) { item.text = previous; throw error; }
    this.onChange({ type: "edited", message: { ...item } }); return { ...item };
  }); }
  async delete(id: string): Promise<void> { return this.exclusive(async () => {
    const item = this.find(id); if (item.status === "in-flight") throw new RrError(`message ${id} is in flight`);
    const index = this.data.items.indexOf(item); this.data.items.splice(index, 1);
    try { await this.persist(); } catch (error) { this.data.items.splice(index, 0, item); throw error; }
    this.onChange({ type: "deleted", messageId: id });
  }); }
  async claim(): Promise<QueuedMessage | undefined> { return this.exclusive(async () => {
    if (this.data.items.some((item) => item.status === "in-flight")) return undefined;
    const item = this.data.items.filter((m) => m.status === "queued").sort((a, b) => a.order - b.order)[0];
    if (!item) return undefined; item.status = "in-flight"; item.attempts++; try { await this.persist(); } catch (error) { item.status = "queued"; item.attempts--; throw error; } this.onChange({ type: "claimed", message: { ...item } }); return { ...item };
  }); }
  async complete(id: string): Promise<void> { return this.exclusive(async () => {
    const item = this.find(id); if (item.status !== "in-flight") throw new RrError(`message ${id} is not in flight`);
    const index = this.data.items.indexOf(item); this.data.items.splice(index, 1); try { await this.persist(); } catch (error) { this.data.items.splice(index, 0, item); throw error; } this.onChange({ type: "completed", messageId: id });
  }); }
  async release(id: string, reason?: string): Promise<void> { return this.exclusive(async () => {
    const item = this.find(id), previous = item.status; item.status = "queued"; try { await this.persist(); } catch (error) { item.status = previous; throw error; } this.onChange(reason === undefined ? { type: "released", message: { ...item } } : { type: "released", message: { ...item }, reason });
  }); }
  private find(id: string): QueuedMessage { const item = this.data.items.find((m) => m.id === id); if (!item) throw new RrError(`message ${id} is not queued`); return item; }
}

export type QueueEvent = { type: "queued" | "edited" | "claimed"; message: QueuedMessage } | { type: "released"; message: QueuedMessage; reason?: string } | { type: "deleted" | "completed"; messageId: string };

export interface ConversationEvent { sequence: number; type: "user" | "assistant" | "error" | "session"; messageId?: string; text?: string; sessionId?: string; timestamp: string }
export class ConversationStore {
  private events: ConversationEvent[] = [];
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    const raw = await readText(this.file); if (!raw) return;
    this.events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ConversationEvent);
  }
  snapshot(): ConversationEvent[] { return this.events.map((event) => ({ ...event })); }
  async append(event: Omit<ConversationEvent, "sequence" | "timestamp">): Promise<ConversationEvent> {
    const full: ConversationEvent = { ...event, sequence: (this.events.at(-1)?.sequence ?? 0) + 1, timestamp: new Date().toISOString() };
    await ensureDir(dirname(this.file)); await appendFile(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    const handle = await open(this.file, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    this.events.push(full); return { ...full };
  }
  async editUser(messageId: string, text: string): Promise<void> { const event = this.events.find((item) => item.type === "user" && item.messageId === messageId); if (!event) return; event.text = text; await this.rewrite(); }
  async deleteUser(messageId: string): Promise<void> { const index = this.events.findIndex((item) => item.type === "user" && item.messageId === messageId); if (index < 0) return; this.events.splice(index, 1); for (let i = 0; i < this.events.length; i++) this.events[i]!.sequence = i + 1; await this.rewrite(); }
  private async rewrite(): Promise<void> { await atomicWrite(this.file, this.events.map((event) => JSON.stringify(event)).join("\n") + (this.events.length ? "\n" : "")); }
  context(maxMessages: number, maxChars: number): ConversationEvent[] {
    if (maxMessages === 0 || maxChars === 0) return [];
    const selected: ConversationEvent[] = []; let chars = 0;
    for (const event of this.events.filter((item) => item.type === "user" || item.type === "assistant").toReversed()) {
      const length = event.text?.length ?? 0;
      if (selected.length >= maxMessages || chars + length > maxChars) break;
      chars += length; selected.unshift({ ...event });
    }
    return selected;
  }
}
