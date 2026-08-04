import { createHash } from "node:crypto";
import { atomicWrite, readText } from "./fs.ts";
import type { ModelSelection } from "./model-selection.ts";
import type { IntegralPaths } from "./paths.ts";
import type { ScheduleDefinition } from "./schedule-types.ts";
import { IntegralError } from "./errors.ts";

export type OccurrenceState =
  "pending" | "accepted" | "succeeded" | "failed" | "cancelled" | "coalesced";

export interface ScheduledOccurrence {
  executionId: string;
  scheduleId: string;
  scheduleRevision: number;
  triggerType: "recurring" | "once";
  scheduledFor: string;
  prompt: string;
  profile: ModelSelection;
  state: OccurrenceState;
  dispatchAttempts: number;
  createdAt: string;
  acceptedAt?: string;
  completedAt?: string;
  coordinatorTaskId?: string;
  lastError?: string;
}

interface OccurrenceFile {
  occurrences: ScheduledOccurrence[];
}

export function executionId(
  scheduleId: string,
  revision: number,
  scheduledFor: string,
): string {
  return createHash("sha256")
    .update(`${scheduleId}\0${revision}\0${scheduledFor}`)
    .digest("hex")
    .toUpperCase();
}

export class OccurrenceStore {
  private data: OccurrenceFile = { occurrences: [] };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: IntegralPaths,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const raw = await readText(this.paths.occurrences);
    if (!raw) return;
    const parsed = JSON.parse(raw) as OccurrenceFile;
    if (!Array.isArray(parsed.occurrences))
      throw new Error("invalid occurrence file");
    this.data = parsed;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async persist(): Promise<void> {
    await atomicWrite(this.paths.occurrences, `${JSON.stringify(this.data)}\n`);
  }

  snapshot(): ScheduledOccurrence[] {
    return this.data.occurrences.map((item) => structuredClone(item));
  }

  forSchedule(scheduleId: string, revision?: number): ScheduledOccurrence[] {
    return this.snapshot().filter(
      (item) =>
        item.scheduleId === scheduleId &&
        (revision === undefined || item.scheduleRevision === revision),
    );
  }

  active(): ScheduledOccurrence[] {
    return this.snapshot().filter(
      (item) => item.state === "pending" || item.state === "accepted",
    );
  }

  async materialize(
    schedule: ScheduleDefinition,
    scheduledFor: string,
    state: "pending" | "coalesced" = "pending",
  ): Promise<ScheduledOccurrence> {
    return this.exclusive(async () => {
      const id = executionId(schedule.id, schedule.revision, scheduledFor),
        existing = this.data.occurrences.find(
          (item) => item.executionId === id,
        );
      if (existing) return structuredClone(existing);
      const occurrence: ScheduledOccurrence = {
        executionId: id,
        scheduleId: schedule.id,
        scheduleRevision: schedule.revision,
        triggerType: schedule.trigger.type,
        scheduledFor,
        prompt: schedule.prompt,
        profile: structuredClone(schedule.profile),
        state,
        dispatchAttempts: 0,
        createdAt: new Date(this.now()).toISOString(),
      };
      this.data.occurrences.push(occurrence);
      await this.persist();
      return structuredClone(occurrence);
    });
  }

  async recordDispatch(execution: string): Promise<ScheduledOccurrence> {
    return this.change(execution, (item) => {
      if (item.state === "pending") item.dispatchAttempts++;
    });
  }

  async accept(
    execution: string,
    coordinatorTaskId: string,
  ): Promise<ScheduledOccurrence> {
    return this.change(execution, (item) => {
      if (item.state !== "pending" && item.state !== "accepted") return;
      item.state = "accepted";
      item.coordinatorTaskId = coordinatorTaskId;
      item.acceptedAt ??= new Date(this.now()).toISOString();
    });
  }

  async acknowledge(
    execution: string,
    outcome: "succeeded" | "failed" | "cancelled",
    error?: string,
  ): Promise<ScheduledOccurrence> {
    return this.change(execution, (item) => {
      if (["succeeded", "failed", "cancelled"].includes(item.state)) {
        if (item.state !== outcome)
          throw new IntegralError(
            `occurrence ${execution} already has outcome ${item.state}`,
            409,
          );
        return;
      }
      item.state = outcome;
      item.completedAt = new Date(this.now()).toISOString();
      if (error) item.lastError = error;
    });
  }

  private change(
    execution: string,
    update: (item: ScheduledOccurrence) => void,
  ): Promise<ScheduledOccurrence> {
    return this.exclusive(async () => {
      const item = this.data.occurrences.find(
        (candidate) => candidate.executionId === execution,
      );
      if (!item) throw new Error(`occurrence not found: ${execution}`);
      const before = structuredClone(item);
      update(item);
      try {
        await this.persist();
      } catch (error) {
        Object.assign(item, before);
        throw error;
      }
      return structuredClone(item);
    });
  }
}
