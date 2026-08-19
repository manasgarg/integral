import { randomUUID } from "node:crypto";
import { atomicWrite, readText } from "./fs.ts";
import type { ModelSelection } from "./model-selection.ts";
import type { ScheduledOccurrence } from "./occurrence-store.ts";
import type { ConversationOriginRoute } from "./schedule-types.ts";
import type { IntegralPaths } from "./paths.ts";
import { IntegralError } from "./errors.ts";
import { SerialExecutor } from "./persistence/serial-executor.ts";

export type TaskState =
  | "queued"
  | "claimed"
  | "running"
  | "retry-wait"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskAttempt {
  attemptId: string;
  number: number;
  startedAt: string;
  finishedAt?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  exitCode?: number;
  error?: string;
  declaration?: TaskOutcomeDeclaration;
}

export interface TaskOutcomeDeclaration {
  outcome: "complete" | "failed";
  message: string;
  declaredAt: string;
}

export interface ScheduledTask {
  id: string;
  executionId: string;
  scheduleId: string;
  scheduleRevision: number;
  triggerType: "recurring" | "once";
  scheduledFor: string;
  prompt: string;
  profile: ModelSelection;
  state: TaskState;
  attempts: TaskAttempt[];
  claimId?: string;
  createdAt: string;
  nextAttemptAt?: string;
  completedAt?: string;
  result?: string;
  lastError?: string;
  origin?: ConversationOriginRoute;
}

export interface TaskOutboxEntry {
  executionId: string;
  outcome: "succeeded" | "failed" | "cancelled";
  error?: string;
  createdAt: string;
  taskId?: string;
  scheduleId?: string;
  result?: string;
  origin?: ConversationOriginRoute;
}

interface TaskFile {
  tasks: ScheduledTask[];
  outbox: TaskOutboxEntry[];
}

function immutableTask(task: ScheduledTask): unknown {
  return {
    executionId: task.executionId,
    scheduleId: task.scheduleId,
    scheduleRevision: task.scheduleRevision,
    triggerType: task.triggerType,
    scheduledFor: task.scheduledFor,
    prompt: task.prompt,
    profile: task.profile,
    origin: task.origin,
  };
}

export class DurableTaskQueue {
  private data: TaskFile = { tasks: [], outbox: [] };
  private readonly operations = new SerialExecutor();

  constructor(
    private readonly paths: IntegralPaths,
    private readonly now: () => number = Date.now,
    private readonly newAttemptId: () => string = randomUUID,
  ) {}

  async load(): Promise<void> {
    const raw = await readText(this.paths.taskQueue);
    if (raw) {
      const parsed = JSON.parse(raw) as TaskFile;
      if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.outbox))
        throw new IntegralError(`invalid task queue: ${this.paths.taskQueue}`);
      this.data = parsed;
    }
    let changed = false;
    for (const task of this.data.tasks.filter(
      (item) => item.state === "claimed" || item.state === "running",
    )) {
      if (task.state === "claimed") {
        task.state = "queued";
        delete task.claimId;
        changed = true;
        continue;
      }
      const attempt = task.attempts.at(-1);
      if (attempt && !attempt.finishedAt) {
        attempt.finishedAt = new Date(this.now()).toISOString();
        attempt.outcome = "interrupted";
        attempt.error = "coordinator restarted with task outcome unknown";
      }
      task.lastError = "task outcome unknown after coordinator restart";
      if (task.triggerType === "recurring") {
        task.state = "failed";
        this.addOutbox(task.executionId, "failed", task.lastError);
      } else task.state = "queued";
      changed = true;
    }
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    await atomicWrite(this.paths.taskQueue, `${JSON.stringify(this.data)}\n`);
  }

  snapshot(): ScheduledTask[] {
    return this.data.tasks.map((item) => structuredClone(item));
  }

  outbox(): TaskOutboxEntry[] {
    return this.data.outbox.map((item) => ({ ...item }));
  }

  async accept(occurrence: ScheduledOccurrence): Promise<ScheduledTask> {
    return this.operations.run(async () => {
      const existing = this.data.tasks.find(
        (item) => item.executionId === occurrence.executionId,
      );
      const candidate: ScheduledTask = {
        id: occurrence.executionId,
        executionId: occurrence.executionId,
        scheduleId: occurrence.scheduleId,
        scheduleRevision: occurrence.scheduleRevision,
        triggerType: occurrence.triggerType,
        scheduledFor: occurrence.scheduledFor,
        prompt: occurrence.prompt,
        profile: structuredClone(occurrence.profile),
        state: "queued",
        attempts: [],
        createdAt: new Date(this.now()).toISOString(),
        ...(occurrence.origin
          ? { origin: structuredClone(occurrence.origin) }
          : {}),
      };
      if (existing) {
        if (
          JSON.stringify(immutableTask(existing)) !==
          JSON.stringify(immutableTask(candidate))
        )
          throw new IntegralError(
            `execution ${occurrence.executionId} conflicts with accepted task`,
            409,
          );
        return structuredClone(existing);
      }
      this.data.tasks.push(candidate);
      await this.persist();
      return structuredClone(candidate);
    });
  }

  async claim(): Promise<ScheduledTask | undefined> {
    return this.operations.run(async () => {
      if (
        this.data.tasks.some(
          (item) => item.state === "claimed" || item.state === "running",
        )
      )
        return undefined;
      const now = this.now(),
        task = this.data.tasks.find(
          (item) =>
            item.state === "queued" ||
            (item.state === "retry-wait" &&
              Date.parse(item.nextAttemptAt ?? "") <= now),
        );
      if (!task) return undefined;
      task.state = "claimed";
      delete task.nextAttemptAt;
      task.claimId = this.newAttemptId();
      await this.persist();
      return structuredClone(task);
    });
  }

  async start(executionId: string, claimId: string): Promise<ScheduledTask> {
    return this.operations.run(async () => {
      const task = this.find(executionId);
      if (task.state !== "claimed" || task.claimId !== claimId)
        throw new IntegralError(`task claim is not active: ${claimId}`, 409);
      task.state = "running";
      delete task.claimId;
      task.attempts.push({
        attemptId: this.newAttemptId(),
        number: task.attempts.length + 1,
        startedAt: new Date(this.now()).toISOString(),
      });
      await this.persist();
      return structuredClone(task);
    });
  }

  async releaseClaim(
    executionId: string,
    claimId: string,
    error: string,
  ): Promise<ScheduledTask> {
    return this.operations.run(async () => {
      const task = this.find(executionId);
      if (task.state !== "claimed" || task.claimId !== claimId)
        return structuredClone(task);
      task.state = "queued";
      delete task.claimId;
      task.lastError = error;
      await this.persist();
      return structuredClone(task);
    });
  }

  async complete(
    executionId: string,
    attemptId: string,
    result: string,
    exitCode: number,
  ): Promise<ScheduledTask> {
    return this.operations.run(async () => {
      const task = this.find(executionId);
      if (task.state === "completed") {
        const attempt = task.attempts.at(-1);
        if (task.result !== result || attempt?.exitCode !== exitCode)
          throw new IntegralError(
            `task ${executionId} already completed with a different result`,
            409,
          );
        return structuredClone(task);
      }
      const attempt = this.runningAttempt(task, attemptId);
      if (exitCode !== 0)
        throw new IntegralError("task success requires exit code zero", 409);
      if (attempt.declaration?.outcome !== "complete")
        throw new IntegralError(
          "task success requires Pi to declare completion",
          409,
        );
      if (attempt.declaration.message !== result)
        throw new IntegralError(
          "task result does not match Pi's completion declaration",
          409,
        );
      const timestamp = new Date(this.now()).toISOString();
      attempt.finishedAt = timestamp;
      attempt.outcome = "succeeded";
      attempt.exitCode = exitCode;
      task.state = "completed";
      task.result = result;
      task.completedAt = timestamp;
      delete task.lastError;
      this.addOutbox(task.executionId, "succeeded");
      await this.persist();
      return structuredClone(task);
    });
  }

  async declareOutcome(
    executionId: string,
    attemptId: string,
    outcome: "complete" | "failed",
    message: string,
  ): Promise<ScheduledTask> {
    return this.operations.run(async () => {
      if (!message.trim())
        throw new IntegralError("task outcome message is required", 400);
      if (message.length > 100_000)
        throw new IntegralError("task outcome message is too large", 413);
      const task = this.find(executionId),
        priorAttempt = task.attempts.find(
          (item) => item.attemptId === attemptId,
        ),
        attempt = priorAttempt ?? this.runningAttempt(task, attemptId),
        existing = attempt.declaration;
      if (existing) {
        if (existing.outcome !== outcome || existing.message !== message)
          throw new IntegralError(
            `task attempt ${attemptId} already has a conflicting outcome declaration`,
            409,
          );
        return structuredClone(task);
      }
      this.runningAttempt(task, attemptId);
      attempt.declaration = {
        outcome,
        message,
        declaredAt: new Date(this.now()).toISOString(),
      };
      await this.persist();
      return structuredClone(task);
    });
  }

  async finalize(
    executionId: string,
    attemptId: string,
    exitCode: number,
  ): Promise<ScheduledTask> {
    return this.operations.run(async () => {
      const task = this.find(executionId),
        priorAttempt = task.attempts.find(
          (item) => item.attemptId === attemptId,
        );
      if (task.state !== "running" && priorAttempt?.finishedAt)
        return structuredClone(task);
      const attempt = this.runningAttempt(task, attemptId),
        declaration = attempt.declaration,
        timestamp = new Date(this.now()).toISOString();
      if (exitCode === 0 && declaration?.outcome === "complete") {
        attempt.finishedAt = timestamp;
        attempt.outcome = "succeeded";
        attempt.exitCode = exitCode;
        task.state = "completed";
        task.result = declaration.message;
        task.completedAt = timestamp;
        delete task.lastError;
        this.addOutbox(task.executionId, "succeeded");
      } else {
        const error =
          exitCode !== 0
            ? `Pi task exited non-zero (${exitCode})`
            : declaration?.outcome === "failed"
              ? declaration.message
              : "Pi exited without declaring task completion or failure";
        attempt.finishedAt = timestamp;
        attempt.outcome = "failed";
        attempt.exitCode = exitCode;
        attempt.error = error;
        task.lastError = error;
        if (task.triggerType === "recurring") {
          task.state = "failed";
          task.completedAt = timestamp;
          this.addOutbox(task.executionId, "failed", error);
        } else {
          task.state = "retry-wait";
          task.nextAttemptAt = new Date(
            this.now() + retryDelay(task.attempts.length),
          ).toISOString();
        }
      }
      await this.persist();
      return structuredClone(task);
    });
  }

  async fail(
    executionId: string,
    attemptId: string,
    error: string,
    exitCode?: number,
  ): Promise<ScheduledTask> {
    return this.operations.run(async () => {
      const task = this.find(executionId),
        priorAttempt = task.attempts.find(
          (item) => item.attemptId === attemptId,
        );
      if (task.state !== "running" && priorAttempt?.finishedAt)
        return structuredClone(task);
      const attempt = this.runningAttempt(task, attemptId),
        timestamp = new Date(this.now()).toISOString();
      attempt.finishedAt = timestamp;
      attempt.outcome = "failed";
      attempt.error = error;
      if (exitCode !== undefined) attempt.exitCode = exitCode;
      task.lastError = error;
      if (task.triggerType === "recurring") {
        task.state = "failed";
        task.completedAt = timestamp;
        this.addOutbox(task.executionId, "failed", error);
      } else {
        task.state = "retry-wait";
        task.nextAttemptAt = new Date(
          this.now() + retryDelay(task.attempts.length),
        ).toISOString();
      }
      await this.persist();
      return structuredClone(task);
    });
  }

  async cancel(executionId: string): Promise<ScheduledTask> {
    return this.operations.run(async () => {
      const task = this.find(executionId);
      if (task.triggerType !== "once")
        throw new IntegralError(
          "failed recurring occurrences cannot be retried or cancelled",
          409,
        );
      if (task.state === "completed")
        throw new IntegralError("completed task cannot be cancelled", 409);
      const timestamp = new Date(this.now()).toISOString();
      if (task.state === "running") {
        const attempt = task.attempts.at(-1);
        if (attempt && !attempt.finishedAt) {
          attempt.finishedAt = timestamp;
          attempt.outcome = "interrupted";
          attempt.error = "cancelled by operator";
        }
      }
      delete task.claimId;
      task.state = "cancelled";
      task.completedAt = timestamp;
      this.addOutbox(task.executionId, "cancelled", "cancelled by operator");
      await this.persist();
      return structuredClone(task);
    });
  }

  async acknowledgeOutbox(executionId: string): Promise<void> {
    return this.operations.run(async () => {
      const index = this.data.outbox.findIndex(
        (item) => item.executionId === executionId,
      );
      if (index < 0) return;
      this.data.outbox.splice(index, 1);
      await this.persist();
    });
  }

  private addOutbox(
    executionId: string,
    outcome: TaskOutboxEntry["outcome"],
    error?: string,
  ): void {
    if (this.data.outbox.some((item) => item.executionId === executionId))
      return;
    this.data.outbox.push({
      executionId,
      outcome,
      taskId: this.find(executionId).id,
      scheduleId: this.find(executionId).scheduleId,
      ...(this.find(executionId).result
        ? { result: this.find(executionId).result }
        : {}),
      ...(this.find(executionId).origin
        ? { origin: structuredClone(this.find(executionId).origin) }
        : {}),
      ...(error ? { error } : {}),
      createdAt: new Date(this.now()).toISOString(),
    });
  }

  private find(executionId: string): ScheduledTask {
    const task = this.data.tasks.find(
      (item) => item.executionId === executionId,
    );
    if (!task) throw new IntegralError(`task not found: ${executionId}`, 404);
    return task;
  }

  private runningAttempt(task: ScheduledTask, attemptId: string): TaskAttempt {
    const attempt = task.attempts.at(-1);
    if (
      task.state !== "running" ||
      !attempt ||
      attempt.attemptId !== attemptId ||
      attempt.finishedAt
    )
      throw new IntegralError(`task attempt is not running: ${attemptId}`, 409);
    return attempt;
  }
}

function retryDelay(attempts: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempts - 1, 10));
}
