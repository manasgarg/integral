import { randomUUID } from "node:crypto";
import { appendFile, chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EffectiveConfig } from "./config.ts";
import type { PiProtocolEvent } from "./container/pi-protocol.ts";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import type { ModelSelection } from "./model-selection.ts";
import type { IntegralPaths } from "./paths.ts";

export type RunKind = "interactive" | "scheduled";
export type RunTermination =
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "timed-out"
  | "idle"
  | "selection-changed"
  | "stopped";

export interface RunMetadata {
  schemaVersion: 1;
  runId: string;
  kind: RunKind;
  status: "running" | "finalized";
  sessionId: string;
  model: ModelSelection;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  termination?: RunTermination;
  error?: string;
  parentRunId?: string;
  parentSessionId?: string;
  approvalId?: string;
  priorAttemptRunId?: string;
  scheduleId?: string;
  executionId?: string;
  attemptId?: string;
  attemptNumber?: number;
  retryNumber?: number;
  limits: {
    turnTimeoutSeconds: number;
    idleTimeoutSeconds: number;
    taskTimeoutSeconds?: number;
  };
  declaration?: {
    outcome: "complete" | "failed";
    message: string;
    declaredAt: string;
  };
}

export interface RunEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  at: string;
  source: "host" | "pi" | "provider" | "user";
  type: string;
  data: unknown;
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cost?: { amount: number; currency: string };
}

export interface LearningSignals {
  schemaVersion: 1;
  runId: string;
  eventCount: number;
  counts: Record<string, number>;
  references: Record<string, string[]>;
  usage: NormalizedUsage & {
    requestCount: number;
    cacheReuseRatio?: number;
    costs: Array<{ amount: number; currency: string }>;
    unavailable: Array<(typeof usageKeys)[number] | "cost">;
  };
  elapsedMs?: number;
  outcome?: RunTermination;
}

export interface BeginRunOptions {
  kind: RunKind;
  sessionId: string;
  model: ModelSelection;
  config: EffectiveConfig;
  parentRunId?: string;
  parentSessionId?: string;
  approvalId?: string;
  priorAttemptRunId?: string;
  scheduleId?: string;
  executionId?: string;
  attemptId?: string;
  attemptNumber?: number;
  retryNumber?: number;
  sensitiveValues?: string[];
}

export interface FinalizeRunOptions {
  termination: RunTermination;
  error?: string;
  declaration?: RunMetadata["declaration"];
}

interface UsageSample {
  normalized: NormalizedUsage;
  provider: unknown;
}

const sensitiveKey =
  /authorization|cookie|credential|secret|password|api[_-]?key|oauth.*code|(?:access|refresh|session)[_-]?token/i;

export class RunStore {
  constructor(
    private readonly paths: IntegralPaths,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  async initialize(): Promise<void> {
    await ensureDir(this.paths.runs);
    await removeTree(this.paths.runViews);
    await ensureDir(this.paths.runViews);
    for (const entry of await readdir(this.paths.runs, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.paths.runs, entry.name),
        metadata = await readMetadata(directory);
      if (!metadata || metadata.status !== "running") continue;
      const events = await readEvents(directory),
        recorder = new RunRecorder(
          directory,
          metadata,
          this.now,
          this.newId,
          [],
          events,
        );
      await recorder.event("host", "interrupted", {
        error: "runner restarted before the run was finalized",
      });
      await recorder.finalize({
        termination: "interrupted",
        error: "runner restarted before the run was finalized",
      });
    }
  }

  async begin(options: BeginRunOptions): Promise<RunRecorder> {
    await ensureDir(this.paths.runs);
    const started = this.now(),
      runId = `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${this.newId().slice(0, 8)}`,
      directory = join(this.paths.runs, runId),
      metadata: RunMetadata = {
        schemaVersion: 1,
        runId,
        kind: options.kind,
        status: "running",
        sessionId: options.sessionId,
        model: structuredClone(options.model),
        startedAt: new Date(started).toISOString(),
        limits: {
          turnTimeoutSeconds: options.config.runner.turnTimeoutSeconds,
          idleTimeoutSeconds: options.config.runner.idleTimeoutSeconds,
          ...(options.kind === "scheduled"
            ? { taskTimeoutSeconds: options.config.runner.turnTimeoutSeconds }
            : {}),
        },
        ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
        ...(options.parentSessionId
          ? { parentSessionId: options.parentSessionId }
          : {}),
        ...(options.approvalId ? { approvalId: options.approvalId } : {}),
        ...(options.priorAttemptRunId
          ? { priorAttemptRunId: options.priorAttemptRunId }
          : {}),
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
        ...(options.executionId ? { executionId: options.executionId } : {}),
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
        ...(options.attemptNumber !== undefined
          ? { attemptNumber: options.attemptNumber }
          : {}),
        ...(options.retryNumber !== undefined
          ? { retryNumber: options.retryNumber }
          : {}),
      };
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`run ID collision: ${runId}`, { cause: error });
      throw error;
    }
    await atomicWrite(join(directory, "run.json"), json(metadata));
    await atomicWrite(join(directory, "activity.jsonl"), "");
    return new RunRecorder(
      directory,
      metadata,
      this.now,
      this.newId,
      options.sensitiveValues,
    );
  }

  async createHistoryView(current: RunRecorder): Promise<string> {
    await ensureDir(this.paths.runViews);
    const directory = join(
        this.paths.runViews,
        `${current.runId}-${this.newId().slice(0, 8)}`,
      ),
      runsDirectory = join(directory, "runs");
    await ensureDir(runsDirectory, 0o755);
    try {
      const records: RunMetadata[] = [];
      for (const entry of await readdir(this.paths.runs, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || entry.name === current.runId) continue;
        const source = join(this.paths.runs, entry.name),
          metadata = await readMetadata(source);
        if (!metadata || metadata.status !== "finalized") continue;
        records.push(metadata);
        await cp(source, join(runsDirectory, metadata.runId), {
          recursive: true,
        });
      }
      records.sort(
        (left, right) =>
          Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
          left.runId.localeCompare(right.runId),
      );
      await atomicWrite(
        join(directory, "index.json"),
        json({ schemaVersion: 1, runs: records }),
        0o444,
      );
      await makeReadOnly(runsDirectory);
      await current.projectTo(join(directory, "current"));
      return directory;
    } catch (error) {
      await removeTree(directory).catch(() => undefined);
      throw error;
    }
  }

  async removeHistoryView(path: string | undefined): Promise<void> {
    if (!path) return;
    const prefix = `${this.paths.runViews}/`;
    if (!path.startsWith(prefix)) return;
    await removeTree(path);
  }

  async finalizedForExecution(executionId: string): Promise<RunMetadata[]> {
    await ensureDir(this.paths.runs);
    const result: RunMetadata[] = [];
    for (const entry of await readdir(this.paths.runs, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const metadata = await readMetadata(join(this.paths.runs, entry.name));
      if (
        metadata?.status === "finalized" &&
        metadata.executionId === executionId
      )
        result.push(metadata);
    }
    return result.sort(
      (left, right) => (left.attemptNumber ?? 0) - (right.attemptNumber ?? 0),
    );
  }

  async latestFinalized(kind: RunKind): Promise<RunMetadata | undefined> {
    await ensureDir(this.paths.runs);
    const result: RunMetadata[] = [];
    for (const entry of await readdir(this.paths.runs, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const metadata = await readMetadata(join(this.paths.runs, entry.name));
      if (metadata?.status === "finalized" && metadata.kind === kind)
        result.push(metadata);
    }
    return result.sort(
      (left, right) =>
        Date.parse(right.startedAt) - Date.parse(left.startedAt) ||
        right.runId.localeCompare(left.runId),
    )[0];
  }
}

export class RunRecorder {
  private chain: Promise<void> = Promise.resolve();
  private sequence = 0;
  private finalized = false;
  private readonly secrets: string[];
  private readonly toolStarts = new Map<string, number>();
  private readonly events: RunEvent[];
  private projection: string | undefined;
  private writeError: unknown;

  constructor(
    private readonly directory: string,
    private metadata: RunMetadata,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
    sensitiveValues: string[] = [],
    initialEvents: RunEvent[] = [],
  ) {
    this.secrets = sensitiveValues.filter(Boolean);
    this.events = [...initialEvents];
    this.sequence = initialEvents.reduce(
      (maximum, event) => Math.max(maximum, event.sequence),
      0,
    );
  }

  get runId(): string {
    return this.metadata.runId;
  }

  async projectTo(directory: string): Promise<void> {
    await this.chain;
    if (this.writeError)
      throw this.writeError instanceof Error
        ? this.writeError
        : new Error("run event write failed", { cause: this.writeError });
    await removeTree(directory);
    await cp(this.directory, directory, { recursive: true });
    await makeWritable(directory);
    this.projection = directory;
    await this.writeProjectionSignals();
  }

  event(
    source: RunEvent["source"],
    type: string,
    data: unknown,
  ): Promise<void> {
    if (this.finalized) return Promise.resolve();
    const event: RunEvent = {
      schemaVersion: 1,
      eventId: this.newId(),
      sequence: ++this.sequence,
      at: new Date(this.now()).toISOString(),
      source,
      type,
      data: redact(data, this.secrets),
    };
    return this.enqueue(async () => {
      await appendFile(join(this.directory, "activity.jsonl"), json(event), {
        mode: 0o600,
      });
      this.events.push(event);
      if (this.projection) {
        await appendFile(join(this.projection, "activity.jsonl"), json(event), {
          mode: 0o644,
        });
        await this.writeProjectionSignals();
      }
    });
  }

  input(
    text: string,
    category:
      | "original-request"
      | "follow-up"
      | "retry-instruction"
      | "task-outcome-reminder"
      | "approval-resolution",
    relationships: Record<string, string> = {},
  ): Promise<void> {
    return this.event("user", "input", { category, text, relationships });
  }

  output(text: string, elapsedMs?: number): Promise<void> {
    return this.event("pi", "output", {
      text,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    });
  }

  failure(
    type: string,
    error: unknown,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    return this.event("host", type, {
      error: error instanceof Error ? error.message : String(error),
      ...context,
    });
  }

  protocol(event: PiProtocolEvent): void {
    const type = typeof event.type === "string" ? event.type : "unknown",
      usage = type === "message_end" ? usageSamples(event) : [];
    if (isToolEvent(type)) {
      const eventType = toolEventType(type),
        identity = toolIdentity(event);
      if (eventType === "tool-start" && identity)
        this.toolStarts.set(identity, this.now());
      const started = identity ? this.toolStarts.get(identity) : undefined,
        data =
          eventType === "tool-result" && started !== undefined
            ? { ...event, elapsedMs: Math.max(0, this.now() - started) }
            : event;
      if (eventType === "tool-result" && identity)
        this.toolStarts.delete(identity);
      this.background(this.event("pi", eventType, data));
    } else if (isFailureEvent(event))
      this.background(this.event("pi", "protocol-failure", event));
    if (type === "message_update") {
      const update = event.assistantMessageEvent;
      if (
        isObject(update) &&
        update.type === "text_delta" &&
        typeof update.delta === "string"
      )
        this.background(
          this.event("pi", "output-delta", { text: update.delta }),
        );
    }
    for (const sample of usage)
      this.background(
        this.event("provider", "usage", {
          normalized: sample.normalized,
          unavailable: usageKeys.filter(
            (key) => sample.normalized[key] === undefined,
          ),
          provider: sample.provider,
        }),
      );
  }

  async annotate(
    values: Partial<
      Pick<
        RunMetadata,
        | "attemptId"
        | "attemptNumber"
        | "retryNumber"
        | "priorAttemptRunId"
        | "declaration"
      >
    >,
  ): Promise<void> {
    if (this.finalized) return;
    await this.enqueue(async () => {
      this.metadata = { ...this.metadata, ...structuredClone(values) };
      await atomicWrite(join(this.directory, "run.json"), json(this.metadata));
      if (this.projection) {
        await atomicWrite(
          join(this.projection, "run.json"),
          json(this.metadata),
          0o644,
        );
        await this.writeProjectionSignals();
      }
    });
  }

  async finalize(options: FinalizeRunOptions): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    try {
      await this.chain;
      if (this.writeError)
        throw this.writeError instanceof Error
          ? this.writeError
          : new Error("run event write failed", { cause: this.writeError });
      const finished = this.now();
      this.metadata = {
        ...this.metadata,
        status: "finalized",
        finishedAt: new Date(finished).toISOString(),
        elapsedMs: Math.max(0, finished - Date.parse(this.metadata.startedAt)),
        termination: options.termination,
        ...(options.error
          ? { error: redactText(options.error, this.secrets) }
          : {}),
        ...(options.declaration
          ? {
              declaration: redact(
                options.declaration,
                this.secrets,
              ) as NonNullable<RunMetadata["declaration"]>,
            }
          : {}),
      };
      const signals = summarize(this.metadata, this.events);
      await atomicWrite(join(this.directory, "signals.json"), json(signals));
      await atomicWrite(join(this.directory, "run.json"), json(this.metadata));
      if (this.projection) {
        await atomicWrite(
          join(this.projection, "signals.json"),
          json(signals),
          0o644,
        );
        await atomicWrite(
          join(this.projection, "run.json"),
          json(this.metadata),
          0o644,
        );
      }
    } catch (error) {
      this.finalized = false;
      throw error;
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.chain.then(work, work).catch((error: unknown) => {
      this.writeError ??= error;
      throw error;
    });
    this.chain = result.catch(() => undefined);
    return result;
  }

  private background(operation: Promise<void>): void {
    void operation.catch((error: unknown) => {
      this.writeError ??= error;
    });
  }

  private async writeProjectionSignals(): Promise<void> {
    if (!this.projection) return;
    await atomicWrite(
      join(this.projection, "signals.json"),
      json(summarize(this.metadata, this.events)),
      0o644,
    );
  }
}

async function readMetadata(
  directory: string,
): Promise<RunMetadata | undefined> {
  const raw = await readText(join(directory, "run.json"));
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<RunMetadata>;
    if (
      value.schemaVersion !== 1 ||
      value.runId !== basename(directory) ||
      (value.status !== "running" && value.status !== "finalized") ||
      (value.kind !== "interactive" && value.kind !== "scheduled")
    )
      return undefined;
    return value as RunMetadata;
  } catch {
    return undefined;
  }
}

async function readEvents(directory: string): Promise<RunEvent[]> {
  const raw = await readText(join(directory, "activity.jsonl"));
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

function summarize(metadata: RunMetadata, events: RunEvent[]): LearningSignals {
  const counts: Record<string, number> = {},
    references: Record<string, string[]> = {},
    totals: NormalizedUsage = {},
    costs = new Map<string, number>();
  let requestCount = 0;
  for (const event of events) {
    addReference(counts, references, event.type, event.eventId);
    for (const category of learningCategories(event))
      if (category !== event.type)
        addReference(counts, references, category, event.eventId);
    if (event.type !== "usage" || !isObject(event.data)) continue;
    const normalized = event.data.normalized;
    if (!isObject(normalized)) continue;
    requestCount++;
    for (const key of usageKeys) {
      const value = normalized[key];
      if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
    }
    const cost = normalized.cost;
    if (
      isObject(cost) &&
      typeof cost.amount === "number" &&
      typeof cost.currency === "string"
    )
      costs.set(cost.currency, (costs.get(cost.currency) ?? 0) + cost.amount);
  }
  const cacheDenominator =
      (totals.inputTokens ?? 0) + (totals.cacheReadTokens ?? 0),
    usage = {
      ...totals,
      requestCount,
      ...(cacheDenominator > 0 && totals.cacheReadTokens !== undefined
        ? { cacheReuseRatio: totals.cacheReadTokens / cacheDenominator }
        : {}),
      costs: [...costs].map(([currency, amount]) => ({ amount, currency })),
      unavailable: [
        ...usageKeys.filter((key) => totals[key] === undefined),
        ...(costs.size === 0 ? (["cost"] as const) : []),
      ],
    };
  return {
    schemaVersion: 1,
    runId: metadata.runId,
    eventCount: events.length,
    counts,
    references,
    usage,
    ...(metadata.elapsedMs !== undefined
      ? { elapsedMs: metadata.elapsedMs }
      : {}),
    ...(metadata.termination ? { outcome: metadata.termination } : {}),
  };
}

function addReference(
  counts: Record<string, number>,
  references: Record<string, string[]>,
  category: string,
  eventId: string,
): void {
  counts[category] = (counts[category] ?? 0) + 1;
  (references[category] ??= []).push(eventId);
}

function learningCategories(event: RunEvent): string[] {
  const result: string[] = [],
    serialized = JSON.stringify(event.data).toLowerCase();
  if (event.type === "tool-result" && observableFailure(event.data)) {
    result.push("tool-failure");
    const tool = toolName(event.data)?.toLowerCase() ?? "";
    if (/exec|command|shell|bash|terminal/.test(tool))
      result.push("command-failure");
    if (
      /test|lint|typecheck|validation|check/.test(tool) ||
      /validation failed|tests? failed|lint failed|typecheck failed/.test(
        serialized,
      )
    )
      result.push("validation-failure");
  }
  if (/denied|refused|forbidden|policy rejected/.test(serialized))
    result.push("denied-operation");
  if (/timed?[- ]?out|timeout/.test(serialized)) result.push("timeout");
  if (/cancelled|canceled/.test(serialized)) result.push("cancellation");
  if (event.type === "input" && /retry-instruction/.test(serialized))
    result.push("retry");
  if (
    event.type === "input" &&
    /task-outcome-reminder|steering/.test(serialized)
  )
    result.push("steering");
  return [...new Set(result)];
}

function observableFailure(value: unknown): boolean {
  let failed = false;
  visit(value, (key, candidate) => {
    const normalized = key.toLowerCase();
    if (normalized === "success" && candidate === false) failed = true;
    if (
      ["error", "stderr"].includes(normalized) &&
      typeof candidate === "string" &&
      candidate.trim()
    )
      failed = true;
    if (
      ["exitcode", "exit_code", "code"].includes(normalized) &&
      typeof candidate === "number" &&
      candidate !== 0
    )
      failed = true;
    if (
      normalized === "status" &&
      typeof candidate === "string" &&
      /fail|error|denied|timeout|cancel/.test(candidate)
    )
      failed = true;
  });
  return failed;
}

function toolName(value: unknown): string | undefined {
  let result: string | undefined;
  visit(value, (key, candidate) => {
    if (
      result === undefined &&
      ["toolname", "tool_name", "name"].includes(key.toLowerCase()) &&
      typeof candidate === "string"
    )
      result = candidate;
  });
  return result;
}

const usageKeys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

function usageSamples(value: unknown): UsageSample[] {
  const samples: UsageSample[] = [];
  collectUsage(value, samples);
  return samples;
}

function collectUsage(value: unknown, samples: UsageSample[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUsage(item, samples);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, candidate] of Object.entries(value)) {
    if (/usage/i.test(key) && isObject(candidate)) {
      const normalized = normalizeUsage(candidate);
      if (Object.keys(normalized).length)
        samples.push({ normalized, provider: structuredClone(candidate) });
      continue;
    }
    collectUsage(candidate, samples);
  }
}

function normalizeUsage(usage: Record<string, unknown>): NormalizedUsage {
  const flattened = flatten(usage),
    result: NormalizedUsage = {};
  assignNumber(result, "inputTokens", flattened, [
    "input",
    "inputtokens",
    "input_tokens",
    "prompttokens",
    "prompt_tokens",
  ]);
  assignNumber(result, "outputTokens", flattened, [
    "output",
    "outputtokens",
    "output_tokens",
    "completiontokens",
    "completion_tokens",
  ]);
  assignNumber(result, "cacheReadTokens", flattened, [
    "cacheread",
    "cachereadinputtokens",
    "cache_read_input_tokens",
    "cachereadtokens",
    "cache_read_tokens",
    "cachedtokens",
    "cached_tokens",
  ]);
  assignNumber(result, "cacheWriteTokens", flattened, [
    "cachewrite",
    "cachecreationinputtokens",
    "cache_creation_input_tokens",
    "cachewritetokens",
    "cache_write_tokens",
  ]);
  assignNumber(result, "reasoningTokens", flattened, [
    "reasoning",
    "reasoningtokens",
    "reasoning_tokens",
  ]);
  assignNumber(result, "totalTokens", flattened, [
    "totaltokens",
    "total_tokens",
  ]);
  const costSource = isObject(usage.cost) ? flatten(usage.cost) : flattened,
    amount = firstNumber(costSource, [
      "cost",
      "amount",
      "totalcost",
      "total_cost",
      "total",
    ]),
    currency =
      firstString(costSource, ["currency", "costcurrency"]) ??
      firstString(flattened, ["currency", "costcurrency"]);
  if (amount !== undefined && currency) result.cost = { amount, currency };
  return result;
}

function assignNumber(
  target: NormalizedUsage,
  key: (typeof usageKeys)[number],
  source: Map<string, unknown>,
  names: string[],
): void {
  const value = firstNumber(source, names);
  if (value !== undefined) target[key] = value;
}

function firstNumber(
  source: Map<string, unknown>,
  names: string[],
): number | undefined {
  for (const name of names) {
    const value = source.get(name);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return undefined;
}

function firstString(
  source: Map<string, unknown>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = source.get(name);
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function flatten(value: Record<string, unknown>): Map<string, unknown> {
  const result = new Map<string, unknown>();
  visit(value, (key, candidate) => {
    result.set(key.toLowerCase(), candidate);
  });
  return result;
}

function visit(
  value: unknown,
  callback: (key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, candidate] of Object.entries(value)) {
    callback(key, candidate);
    visit(candidate, callback);
  }
}

function isToolEvent(type: string): boolean {
  return /tool.*(?:start|end|result|execution)|(?:start|end|result).*tool/i.test(
    type,
  );
}

function toolEventType(type: string): string {
  if (/start/i.test(type)) return "tool-start";
  if (/end|result/i.test(type)) return "tool-result";
  return "tool-event";
}

function toolIdentity(event: PiProtocolEvent): string | undefined {
  for (const key of ["toolCallId", "tool_call_id", "callId", "id"]) {
    const value = event[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function isFailureEvent(event: PiProtocolEvent): boolean {
  return (
    event.success === false ||
    typeof event.error === "string" ||
    (typeof event.type === "string" &&
      /error|fail|reject|timeout/i.test(event.type))
  );
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, candidate]) => [
      key,
      sensitiveKey.test(key) ? "[redacted]" : redact(candidate, secrets),
    ]),
  );
}

function redactText(value: string, secrets: string[]): string {
  let result = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi,
    "$1[redacted]@",
  );
  result = result.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    "$1 [redacted]",
  );
  for (const secret of secrets)
    if (secret) result = result.split(secret).join("[redacted]");
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function makeReadOnly(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeReadOnly(child);
    else await chmod(child, 0o444);
  }
  await chmod(path, 0o555);
}

async function removeTree(path: string): Promise<void> {
  await makeWritable(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rm(path, { recursive: true, force: true });
}

async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o755);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeWritable(child);
    else await chmod(child, 0o644);
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
