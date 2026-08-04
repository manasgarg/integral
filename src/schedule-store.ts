import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { nextCronInstant } from "./cron.ts";
import { IntegralError } from "./errors.ts";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import type { IntegralPaths } from "./paths.ts";
import type {
  CreateSchedule,
  ScheduleDefinition,
  ScheduleHistoryEntry,
  ScheduleOperation,
  ScheduleTrigger,
  UpdateSchedule,
} from "./schedule-types.ts";
import type { ModelSelection } from "./model-selection.ts";

const execute = promisify(execFile);

export interface GitRuntime {
  run(directory: string, args: string[]): Promise<string>;
}

const systemGit: GitRuntime = {
  async run(directory, args) {
    const result = await execute("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    return result.stdout;
  },
};

function validateTrigger(trigger: ScheduleTrigger, now: number): void {
  if (trigger.type === "recurring") {
    nextCronInstant(trigger.cron, trigger.timezone, now);
    return;
  }
  const instant = Date.parse(trigger.runAt);
  if (!Number.isFinite(instant) || instant <= now)
    throw new IntegralError("one-time schedule runAt must be a future instant");
}

function validatePrompt(prompt: string): void {
  if (!prompt.trim())
    throw new IntegralError("schedule prompt must not be empty");
  if (Buffer.byteLength(prompt, "utf8") > 100_000)
    throw new IntegralError("schedule prompt must not exceed 100000 bytes");
}

function validateProfile(profile: ModelSelection): void {
  for (const [name, value] of Object.entries(profile))
    if (typeof value !== "string" || !value.trim())
      throw new IntegralError(`schedule profile ${name} must be non-empty`);
}

function validateActor(actor: string): void {
  if (!actor.trim() || actor.length > 200 || /[\r\n\0]/.test(actor))
    throw new IntegralError("invalid schedule actor");
}

function parseDefinition(raw: string, file: string): ScheduleDefinition {
  try {
    const value = JSON.parse(raw) as ScheduleDefinition;
    if (
      typeof value.id !== "string" ||
      !Number.isInteger(value.revision) ||
      value.revision < 1 ||
      typeof value.prompt !== "string" ||
      typeof value.enabled !== "boolean" ||
      typeof value.deleted !== "boolean" ||
      !value.trigger ||
      typeof value.trigger !== "object" ||
      !value.profile ||
      typeof value.profile !== "object"
    )
      throw new Error("invalid fields");
    validateProfile(value.profile);
    return value;
  } catch (error) {
    throw new IntegralError(
      `invalid schedule definition ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class ScheduleStore {
  private readonly definitions = new Map<string, ScheduleDefinition>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: IntegralPaths,
    private readonly git: GitRuntime = systemGit,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async load(): Promise<void> {
    await ensureDir(this.paths.schedules);
    let initialized = true;
    try {
      await stat(join(this.paths.schedules, ".git"));
    } catch {
      initialized = false;
    }
    if (!initialized) {
      await this.git.run(this.paths.schedules, ["init", "--quiet", "."]);
      await this.git.run(this.paths.schedules, [
        "config",
        "user.name",
        "Integral Scheduler",
      ]);
      await this.git.run(this.paths.schedules, [
        "config",
        "user.email",
        "scheduler@integral.invalid",
      ]);
    } else await this.recoverWorkingTree();
    this.definitions.clear();
    for (const name of await readdir(this.paths.schedules)) {
      if (!name.endsWith(".json")) continue;
      const raw = await readText(join(this.paths.schedules, name));
      if (!raw) continue;
      const definition = parseDefinition(raw, name);
      this.definitions.set(definition.id, definition);
    }
  }

  private async recoverWorkingTree(): Promise<void> {
    const dirty = await this.git.run(this.paths.schedules, [
      "status",
      "--porcelain",
    ]);
    if (!dirty.trim()) return;
    let hasHead = true;
    try {
      await this.git.run(this.paths.schedules, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
    } catch {
      hasHead = false;
    }
    if (hasHead) {
      await this.git.run(this.paths.schedules, [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        ".",
      ]);
      return;
    }
    for (const name of await readdir(this.paths.schedules))
      if (name.endsWith(".json"))
        await rm(join(this.paths.schedules, name), { force: true });
  }

  list(includeDeleted = false): ScheduleDefinition[] {
    return [...this.definitions.values()]
      .filter((item) => includeDeleted || !item.deleted)
      .map((item) => structuredClone(item))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string, includeDeleted = false): ScheduleDefinition {
    const item = this.definitions.get(id);
    if (!item || (!includeDeleted && item.deleted))
      throw new IntegralError(`schedule not found: ${id}`, 404);
    return structuredClone(item);
  }

  async create(
    input: CreateSchedule,
    actor: string,
  ): Promise<ScheduleDefinition> {
    return this.exclusive(async () => {
      validateActor(actor);
      validatePrompt(input.prompt);
      validateProfile(input.profile);
      validateTrigger(input.trigger, this.now());
      const timestamp = new Date(this.now()).toISOString(),
        definition: ScheduleDefinition = {
          id: this.newId(),
          revision: 1,
          trigger: structuredClone(input.trigger),
          prompt: input.prompt,
          profile: structuredClone(input.profile),
          enabled: true,
          deleted: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      await this.commit(definition, "create", actor);
      return structuredClone(definition);
    });
  }

  async update(
    id: string,
    input: UpdateSchedule,
    actor: string,
  ): Promise<ScheduleDefinition> {
    return this.exclusive(async () => {
      const current = this.current(id, input.expectedRevision);
      validateActor(actor);
      const trigger = input.trigger ?? current.trigger,
        prompt = input.prompt ?? current.prompt;
      validatePrompt(prompt);
      validateProfile(input.profile ?? current.profile);
      validateTrigger(trigger, this.now());
      const next: ScheduleDefinition = {
        ...current,
        revision: current.revision + 1,
        trigger: structuredClone(trigger),
        prompt,
        profile: structuredClone(input.profile ?? current.profile),
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.commit(next, "update", actor);
      return structuredClone(next);
    });
  }

  async setEnabled(
    id: string,
    expectedRevision: number,
    enabled: boolean,
    actor: string,
  ): Promise<ScheduleDefinition> {
    return this.exclusive(async () => {
      const current = this.current(id, expectedRevision);
      validateActor(actor);
      const next = {
        ...current,
        revision: current.revision + 1,
        enabled,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.commit(next, enabled ? "enable" : "disable", actor);
      return structuredClone(next);
    });
  }

  async delete(
    id: string,
    expectedRevision: number,
    actor: string,
  ): Promise<ScheduleDefinition> {
    return this.exclusive(async () => {
      const current = this.current(id, expectedRevision);
      validateActor(actor);
      const next = {
        ...current,
        revision: current.revision + 1,
        enabled: false,
        deleted: true,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.commit(next, "delete", actor);
      return structuredClone(next);
    });
  }

  async restore(
    id: string,
    commit: string,
    expectedRevision: number,
    actor: string,
  ): Promise<ScheduleDefinition> {
    return this.exclusive(async () => {
      const current = this.current(id, expectedRevision, true);
      validateActor(actor);
      if (!/^[0-9a-f]{7,64}$/i.test(commit))
        throw new IntegralError("invalid schedule history commit");
      let raw: string;
      try {
        raw = await this.git.run(this.paths.schedules, [
          "show",
          `${commit}:${this.filename(id)}`,
        ]);
      } catch {
        throw new IntegralError(`schedule revision not found: ${commit}`, 404);
      }
      const restored = parseDefinition(raw, `${commit}:${id}`),
        next: ScheduleDefinition = {
          ...restored,
          id,
          revision: current.revision + 1,
          deleted: false,
          updatedAt: new Date(this.now()).toISOString(),
        };
      validatePrompt(next.prompt);
      validateTrigger(next.trigger, this.now());
      await this.commit(next, "restore", actor);
      return structuredClone(next);
    });
  }

  async history(id: string): Promise<ScheduleHistoryEntry[]> {
    this.get(id, true);
    const output = await this.git.run(this.paths.schedules, [
      "log",
      "--format=%H%x09%cI%x09%s",
      "--",
      this.filename(id),
    ]);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit, committedAt, ...subjectParts] = line.split("\t"),
          metadata = JSON.parse(subjectParts.join("\t")) as Omit<
            ScheduleHistoryEntry,
            "commit" | "committedAt"
          >;
        return { commit: commit!, committedAt: committedAt!, ...metadata };
      })
      .reverse();
  }

  private current(
    id: string,
    expectedRevision: number,
    includeDeleted = false,
  ): ScheduleDefinition {
    const current = this.get(id, includeDeleted);
    if (current.revision !== expectedRevision)
      throw new IntegralError(
        `schedule ${id} revision conflict: expected ${expectedRevision}, current ${current.revision}`,
        409,
      );
    return current;
  }

  private filename(id: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(id))
      throw new IntegralError(`invalid schedule ID: ${id}`);
    return `${id}.json`;
  }

  private async commit(
    definition: ScheduleDefinition,
    operation: ScheduleOperation,
    actor: string,
  ): Promise<void> {
    const file = join(this.paths.schedules, this.filename(definition.id)),
      previous = await readText(file),
      metadata = {
        scheduleId: definition.id,
        revision: definition.revision,
        operation,
        actor,
        timestamp: definition.updatedAt,
      };
    await atomicWrite(file, `${JSON.stringify(definition, null, 2)}\n`);
    try {
      await this.git.run(this.paths.schedules, ["add", "--", basename(file)]);
      await this.git.run(this.paths.schedules, [
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        JSON.stringify(metadata),
      ]);
    } catch (error) {
      if (previous === undefined) await rm(file, { force: true });
      else await atomicWrite(file, previous);
      await this.git
        .run(this.paths.schedules, ["add", "--", basename(file)])
        .catch(() => undefined);
      throw error;
    }
    this.definitions.set(definition.id, structuredClone(definition));
  }
}
