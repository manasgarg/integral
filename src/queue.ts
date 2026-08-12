import { createHash } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import { IntegralError } from "./errors.ts";
import type { ModelSelection } from "./model-selection.ts";
import { SerialExecutor } from "./persistence/serial-executor.ts";

export type QueueStatus = "queued" | "in-flight" | "steering";
export interface MessageOrigin {
  provider: "discord";
  externalId: string;
  userId: string;
  channelId: string;
}
export interface ApprovalContinuation {
  approvalId: string;
  originSessionId: string;
  originRunId?: string;
  outcome: "denied" | "expired" | "stale" | "succeeded" | "failed";
  summary: string;
}
export interface QueuedMessage {
  id: string;
  text: string;
  order: number;
  status: QueueStatus;
  attempts: number;
  createdAt: string;
  approvalContinuation?: ApprovalContinuation;
  origin?: MessageOrigin;
}
interface QueueFile {
  nextOrder: number;
  items: QueuedMessage[];
  snowflake?: SnowflakeState;
}

export const SNOWFLAKE_EPOCH = Date.UTC(2026, 0, 1);
const MAX_SNOWFLAKE_TIME = (1n << 41n) - 1n;
const MAX_WORKER_ID = (1 << 10) - 1;
const MAX_SEQUENCE = (1 << 12) - 1;

export interface SnowflakeState {
  timestamp: number;
  sequence: number;
}

export function createSnowflakeId(
  timestamp: number,
  workerId: number,
  previous?: SnowflakeState,
): { id: string; state: SnowflakeState } {
  if (!Number.isSafeInteger(timestamp))
    throw new RangeError("Snowflake timestamp must be an integer");
  if (!Number.isInteger(workerId) || workerId < 0 || workerId > MAX_WORKER_ID)
    throw new RangeError("Snowflake worker ID must fit in 10 bits");
  let effectiveTimestamp = Math.max(
      timestamp,
      previous?.timestamp ?? timestamp,
    ),
    sequence =
      previous && effectiveTimestamp === previous.timestamp
        ? previous.sequence + 1
        : 0;
  if (sequence > MAX_SEQUENCE) {
    effectiveTimestamp++;
    sequence = 0;
  }
  const elapsed = BigInt(effectiveTimestamp - SNOWFLAKE_EPOCH);
  if (elapsed < 0n || elapsed > MAX_SNOWFLAKE_TIME)
    throw new RangeError("Snowflake timestamp is outside the supported epoch");
  const value = (elapsed << 22n) | (BigInt(workerId) << 12n) | BigInt(sequence);
  return {
    id: value.toString(36).toUpperCase(),
    state: { timestamp: effectiveTimestamp, sequence },
  };
}

function snowflakeWorkerId(file: string): number {
  return (
    createHash("sha256").update(file).digest().readUInt16BE(0) & MAX_WORKER_ID
  );
}

export class DurableQueue {
  private data: QueueFile = { nextOrder: 1, items: [] };
  private readonly operations = new SerialExecutor();
  private readonly workerId: number;
  constructor(
    private readonly file: string,
    private readonly onChange: (event: QueueEvent) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.workerId = snowflakeWorkerId(file);
  }
  async load(): Promise<void> {
    const raw = await readText(this.file);
    if (!raw) return;
    const parsed = JSON.parse(raw) as QueueFile;
    if (
      !Number.isSafeInteger(parsed.nextOrder) ||
      !Array.isArray(parsed.items) ||
      (parsed.snowflake !== undefined &&
        (!Number.isSafeInteger(parsed.snowflake.timestamp) ||
          !Number.isInteger(parsed.snowflake.sequence) ||
          parsed.snowflake.sequence < 0 ||
          parsed.snowflake.sequence > MAX_SEQUENCE))
    )
      throw new IntegralError(`invalid queue file: ${this.file}`);
    this.data = parsed;
    for (const item of this.data.items)
      if (item.status === "in-flight" || item.status === "steering")
        item.status = "queued";
    await this.persist();
  }
  private async persist(): Promise<void> {
    await atomicWrite(this.file, `${JSON.stringify(this.data)}\n`);
  }
  snapshot(): QueuedMessage[] {
    return this.data.items
      .map((item) => ({ ...item }))
      .sort((a, b) => a.order - b.order);
  }
  async enqueue(
    text: string,
    approvalContinuation?: ApprovalContinuation,
    origin?: MessageOrigin,
  ): Promise<QueuedMessage> {
    return this.operations.run(async () => {
      if (!text.trim()) throw new IntegralError("message must not be empty");
      if (origin) {
        const existing = this.data.items.find(
          (item) =>
            item.origin?.provider === origin.provider &&
            item.origin.externalId === origin.externalId,
        );
        if (existing) return structuredClone(existing);
      }
      const priorSnowflake = this.data.snowflake
          ? { ...this.data.snowflake }
          : undefined,
        generated = createSnowflakeId(
          this.now(),
          this.workerId,
          priorSnowflake,
        );
      this.data.snowflake = generated.state;
      const item: QueuedMessage = {
        id: generated.id,
        text,
        order: this.data.nextOrder++,
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
        ...(approvalContinuation
          ? { approvalContinuation: structuredClone(approvalContinuation) }
          : {}),
        ...(origin ? { origin: structuredClone(origin) } : {}),
      };
      this.data.items.push(item);
      try {
        await this.persist();
      } catch (error) {
        this.data.items.pop();
        this.data.nextOrder--;
        if (priorSnowflake) this.data.snowflake = priorSnowflake;
        else delete this.data.snowflake;
        throw error;
      }
      this.onChange({ type: "queued", message: { ...item } });
      return { ...item };
    });
  }
  async edit(id: string, text: string): Promise<QueuedMessage> {
    return this.operations.run(async () => {
      if (!text.trim()) throw new IntegralError("message must not be empty");
      const item = this.find(id);
      if (item.status !== "queued")
        throw new IntegralError(`message ${id} is in flight`);
      const previous = item.text;
      item.text = text;
      try {
        await this.persist();
      } catch (error) {
        item.text = previous;
        throw error;
      }
      this.onChange({ type: "edited", message: { ...item } });
      return { ...item };
    });
  }
  async delete(id: string): Promise<void> {
    return this.operations.run(async () => {
      const item = this.find(id);
      if (item.status !== "queued")
        throw new IntegralError(`message ${id} is in flight`);
      const index = this.data.items.indexOf(item);
      this.data.items.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        this.data.items.splice(index, 0, item);
        throw error;
      }
      this.onChange({ type: "deleted", messageId: id });
    });
  }
  async claim(): Promise<QueuedMessage | undefined> {
    return this.operations.run(async () => {
      if (this.data.items.some((item) => item.status === "in-flight"))
        return undefined;
      const item = this.data.items
        .filter((m) => m.status === "queued")
        .sort((a, b) => a.order - b.order)[0];
      if (!item) return undefined;
      item.status = "in-flight";
      item.attempts++;
      try {
        await this.persist();
      } catch (error) {
        item.status = "queued";
        item.attempts--;
        throw error;
      }
      this.onChange({ type: "claimed", message: { ...item } });
      return { ...item };
    });
  }
  async complete(id: string): Promise<void> {
    return this.operations.run(async () => {
      const item = this.find(id);
      if (item.status !== "in-flight" && item.status !== "steering")
        throw new IntegralError(`message ${id} is not in flight`);
      const index = this.data.items.indexOf(item);
      this.data.items.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        this.data.items.splice(index, 0, item);
        throw error;
      }
      this.onChange({ type: "completed", messageId: id });
    });
  }
  async markSteering(id: string): Promise<void> {
    return this.operations.run(async () => {
      const item = this.find(id);
      if (item.status !== "queued")
        throw new IntegralError(`message ${id} is not queued`);
      item.status = "steering";
      item.attempts++;
      try {
        await this.persist();
      } catch (error) {
        item.status = "queued";
        item.attempts--;
        throw error;
      }
      this.onChange({ type: "steered", message: { ...item } });
    });
  }
  async release(id: string, reason?: string): Promise<void> {
    return this.operations.run(async () => {
      const item = this.find(id),
        previous = item.status;
      item.status = "queued";
      try {
        await this.persist();
      } catch (error) {
        item.status = previous;
        throw error;
      }
      this.onChange(
        reason === undefined
          ? { type: "released", message: { ...item } }
          : { type: "released", message: { ...item }, reason },
      );
    });
  }
  private find(id: string): QueuedMessage {
    const item = this.data.items.find((m) => m.id === id);
    if (!item) throw new IntegralError(`message ${id} is not queued`);
    return item;
  }
}

export type QueueEvent =
  | {
      type: "queued" | "edited" | "claimed" | "steered";
      message: QueuedMessage;
    }
  | { type: "released"; message: QueuedMessage; reason?: string }
  | { type: "deleted" | "completed"; messageId: string };

export interface ConversationEvent {
  sequence: number;
  type: "user" | "assistant" | "error" | "session";
  messageId?: string;
  text?: string;
  sessionId?: string;
  parentSessionId?: string;
  approvalId?: string;
  timestamp: string;
  origin?: MessageOrigin;
}
export class ConversationStore {
  private events: ConversationEvent[] = [];
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    const raw = await readText(this.file);
    if (!raw) return;
    this.events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ConversationEvent);
  }
  snapshot(): ConversationEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
  async append(
    event: Omit<ConversationEvent, "sequence" | "timestamp">,
  ): Promise<ConversationEvent> {
    const full: ConversationEvent = {
      ...event,
      sequence: (this.events.at(-1)?.sequence ?? 0) + 1,
      timestamp: new Date().toISOString(),
    };
    await ensureDir(dirname(this.file));
    await appendFile(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    const handle = await open(this.file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.events.push(full);
    return { ...full };
  }
  async editUser(messageId: string, text: string): Promise<void> {
    const event = this.events.find(
      (item) => item.type === "user" && item.messageId === messageId,
    );
    if (!event) return;
    event.text = text;
    await this.rewrite();
  }
  async deleteUser(messageId: string): Promise<void> {
    const index = this.events.findIndex(
      (item) => item.type === "user" && item.messageId === messageId,
    );
    if (index < 0) return;
    this.events.splice(index, 1);
    for (let i = 0; i < this.events.length; i++)
      this.events[i]!.sequence = i + 1;
    await this.rewrite();
  }
  private async rewrite(): Promise<void> {
    await atomicWrite(
      this.file,
      this.events.map((event) => JSON.stringify(event)).join("\n") +
        (this.events.length ? "\n" : ""),
    );
  }
  context(maxMessages: number, maxChars: number): ConversationEvent[] {
    if (maxMessages === 0 || maxChars === 0) return [];
    const selected: ConversationEvent[] = [];
    let chars = 0;
    for (const event of this.events
      .filter((item) => item.type === "user" || item.type === "assistant")
      .toReversed()) {
      const length = event.text?.length ?? 0;
      if (selected.length >= maxMessages || chars + length > maxChars) break;
      chars += length;
      selected.unshift({ ...event });
    }
    return selected;
  }
}

export class ModelSelectionStore {
  private selection: ModelSelection | undefined;
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    const raw = await readText(this.file);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ModelSelection>;
    if (
      typeof parsed.connection !== "string" ||
      typeof parsed.provider !== "string" ||
      typeof parsed.model !== "string" ||
      typeof parsed.piVersion !== "string" ||
      typeof parsed.piImage !== "string" ||
      !parsed.connection ||
      !parsed.provider ||
      !parsed.model ||
      !parsed.piVersion ||
      !parsed.piImage
    ) {
      // Selections written before runtime identities were introduced are safely
      // retired and selected again through the current runtime catalog.
      this.selection = undefined;
      return;
    }
    this.selection = {
      connection: parsed.connection,
      provider: parsed.provider,
      model: parsed.model,
      piVersion: parsed.piVersion,
      piImage: parsed.piImage,
    };
  }
  get(): ModelSelection | undefined {
    return this.selection ? { ...this.selection } : undefined;
  }
  async set(selection: ModelSelection): Promise<void> {
    await atomicWrite(this.file, `${JSON.stringify(selection)}\n`);
    this.selection = { ...selection };
  }
}
