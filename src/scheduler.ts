import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { nextCronInstant } from "./cron.ts";
import type { EffectiveConfig } from "./config.ts";
import { IntegralError } from "./errors.ts";
import { internalFetch } from "./http-client.ts";
import {
  OccurrenceStore,
  type ScheduledOccurrence,
} from "./occurrence-store.ts";
import type { IntegralPaths } from "./paths.ts";
import {
  nodeHttpServerRuntime,
  nodeIntervalRuntime,
  type HttpServerRuntime,
  type IntervalRuntime,
} from "./runtime.ts";
import { ScheduleStore } from "./schedule-store.ts";
import type {
  CreateSchedule,
  ScheduleDefinition,
  ScheduleTrigger,
  UpdateSchedule,
} from "./schedule-types.ts";
import { componentIdentity, deploymentId, verifyInternal } from "./state.ts";
import { readJsonObject, writeJson } from "./http-server.ts";

export interface SchedulerDependencies {
  servers: HttpServerRuntime;
  intervals: IntervalRuntime;
  internalFetch: typeof internalFetch;
  now(): number;
}

const productionDependencies: SchedulerDependencies = {
  servers: nodeHttpServerRuntime,
  intervals: nodeIntervalRuntime,
  internalFetch,
  now: Date.now,
};

export class Scheduler {
  readonly schedules: ScheduleStore;
  readonly occurrences: OccurrenceStore;
  private readonly dependencies: SchedulerDependencies;
  private server: http.Server | undefined;
  private timer: unknown;
  private token = "";
  private ticking = false;

  constructor(
    private readonly paths: IntegralPaths,
    private readonly config: EffectiveConfig,
    overrides: Partial<SchedulerDependencies> = {},
  ) {
    this.dependencies = { ...productionDependencies, ...overrides };
    this.schedules = new ScheduleStore(paths, undefined, () =>
      this.dependencies.now(),
    );
    this.occurrences = new OccurrenceStore(paths, () =>
      this.dependencies.now(),
    );
  }

  async start(): Promise<http.Server> {
    await this.schedules.load();
    await this.occurrences.load();
    this.token = await componentIdentity(this.paths);
    const server = http.createServer(
      (request, response) => void this.route(request, response),
    );
    this.server = server;
    await this.dependencies.servers.listen(
      server,
      this.config.server.schedulerPort,
      "127.0.0.1",
    );
    await this.tick();
    this.timer = this.dependencies.intervals.setInterval(
      () => void this.tick(),
      1_000,
    );
    return server;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.materialize();
      for (const occurrence of this.occurrences
        .active()
        .filter((item) => item.state === "pending"))
        await this.dispatch(occurrence).catch(() => undefined);
    } finally {
      this.ticking = false;
    }
  }

  private async materialize(): Promise<void> {
    const now = this.dependencies.now();
    for (const schedule of this.schedules.list()) {
      if (!schedule.enabled || schedule.deleted) continue;
      const instants = this.dueInstants(schedule, now);
      for (const instant of instants.slice(0, -1))
        await this.occurrences.materialize(schedule, instant, "coalesced");
      const latest = instants.at(-1);
      if (latest) await this.occurrences.materialize(schedule, latest);
    }
  }

  private dueInstants(schedule: ScheduleDefinition, now: number): string[] {
    const existing = this.occurrences.forSchedule(
      schedule.id,
      schedule.revision,
    );
    if (schedule.trigger.type === "once") {
      return Date.parse(schedule.trigger.runAt) <= now && existing.length === 0
        ? [new Date(schedule.trigger.runAt).toISOString()]
        : [];
    }
    let cursor = existing.length
        ? Math.max(...existing.map((item) => Date.parse(item.scheduledFor)))
        : Date.parse(schedule.updatedAt),
      next = nextCronInstant(
        schedule.trigger.cron,
        schedule.trigger.timezone,
        cursor,
      );
    const result: string[] = [];
    while (next <= now) {
      result.push(new Date(next).toISOString());
      if (result.length > 10_000)
        throw new IntegralError("too many missed schedule occurrences");
      cursor = next;
      next = nextCronInstant(
        schedule.trigger.cron,
        schedule.trigger.timezone,
        cursor,
      );
    }
    return result;
  }

  private async dispatch(occurrence: ScheduledOccurrence): Promise<void> {
    await this.occurrences.recordDispatch(occurrence.executionId);
    const response = await this.dependencies.internalFetch(
      this.paths,
      "scheduler",
      "coordinator",
      `/integral/internal/tasks/${occurrence.executionId}`,
      { method: "PUT", body: JSON.stringify(occurrence) },
    );
    if (!response.ok)
      throw new IntegralError(`task dispatch failed: ${response.status}`);
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== "string")
      throw new IntegralError("coordinator returned an invalid task record");
    await this.occurrences.accept(occurrence.executionId, body.id);
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://scheduler");
      if (url.pathname === "/integral/health" && request.method === "GET") {
        json(response, 200, {
          component: "scheduler",
          deploymentId: deploymentId(this.paths),
          status: "ready",
        });
        return;
      }
      if (url.pathname === "/integral/schedules" && request.method === "GET") {
        json(response, 200, this.schedules.list());
        return;
      }
      if (url.pathname === "/integral/schedules" && request.method === "POST") {
        const body = await bodyJson(request),
          item = await this.schedules.create(createInput(body), actor(body));
        json(response, 201, item);
        return;
      }
      if (
        url.pathname === "/integral/occurrences" &&
        request.method === "GET"
      ) {
        const scheduleId = url.searchParams.get("scheduleId");
        json(
          response,
          200,
          scheduleId
            ? this.occurrences.forSchedule(scheduleId)
            : this.occurrences.snapshot(),
        );
        return;
      }
      const history = url.pathname.match(
        /^\/integral\/schedules\/([^/]+)\/history$/,
      );
      if (history && request.method === "GET") {
        json(response, 200, await this.schedules.history(history[1]!));
        return;
      }
      const action = url.pathname.match(
        /^\/integral\/schedules\/([^/]+)\/(enable|disable|restore)$/,
      );
      if (action && request.method === "POST") {
        const body = await bodyJson(request),
          revision = integer(body.expectedRevision),
          item =
            action[2] === "restore"
              ? await this.schedules.restore(
                  action[1]!,
                  string(body.commit),
                  revision,
                  actor(body),
                )
              : await this.schedules.setEnabled(
                  action[1]!,
                  revision,
                  action[2] === "enable",
                  actor(body),
                );
        json(response, 200, item);
        return;
      }
      const schedule = url.pathname.match(/^\/integral\/schedules\/([^/]+)$/);
      if (schedule && request.method === "GET") {
        json(response, 200, this.schedules.get(schedule[1]!, true));
        return;
      }
      if (schedule && request.method === "PATCH") {
        const body = await bodyJson(request),
          item = await this.schedules.update(
            schedule[1]!,
            updateInput(body),
            actor(body),
          );
        json(response, 200, item);
        return;
      }
      if (schedule && request.method === "DELETE") {
        const body = await bodyJson(request),
          item = await this.schedules.delete(
            schedule[1]!,
            integer(body.expectedRevision),
            actor(body),
          );
        json(response, 200, item);
        return;
      }
      const acknowledgement = url.pathname.match(
        /^\/integral\/internal\/occurrences\/([^/]+)\/ack$/,
      );
      if (acknowledgement && request.method === "POST") {
        if (
          !verifyInternal(
            request.headers,
            "coordinator",
            this.token,
            deploymentId(this.paths),
          )
        )
          return unauthorized(response);
        const body = await bodyJson(request),
          outcome = string(body.outcome);
        if (!["succeeded", "failed", "cancelled"].includes(outcome))
          throw new IntegralError("invalid task outcome", 400);
        const item = await this.occurrences.acknowledge(
          acknowledgement[1]!,
          outcome as "succeeded" | "failed" | "cancelled",
          optionalString(body.error),
        );
        json(response, 200, item);
        return;
      }
      response.writeHead(404).end("not found\n");
    } catch (error) {
      const status = error instanceof IntegralError ? error.exitCode : 500;
      json(response, status >= 400 && status < 600 ? status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(): Promise<void> {
    this.dependencies.intervals.clearInterval(this.timer);
    if (this.server) await this.dependencies.servers.close(this.server);
  }
}

function createInput(body: Record<string, unknown>): CreateSchedule {
  return {
    trigger: trigger(body.trigger),
    prompt: string(body.prompt),
    profile: profile(body.profile),
    ...(body.origin === undefined ? {} : { origin: origin(body.origin) }),
  };
}

function origin(value: unknown): NonNullable<CreateSchedule["origin"]> {
  const item = record(value);
  if (item.provider !== "discord")
    throw new IntegralError("unsupported conversation origin", 400);
  return {
    provider: "discord",
    conversationId: string(item.conversationId),
    externalId: string(item.externalId),
    userId: string(item.userId),
    channelId: string(item.channelId),
  };
}

function updateInput(body: Record<string, unknown>): UpdateSchedule {
  return {
    expectedRevision: integer(body.expectedRevision),
    ...(body.trigger === undefined ? {} : { trigger: trigger(body.trigger) }),
    ...(body.prompt === undefined ? {} : { prompt: string(body.prompt) }),
    ...(body.profile === undefined ? {} : { profile: profile(body.profile) }),
  };
}

function trigger(value: unknown): ScheduleTrigger {
  const item = record(value),
    type = string(item.type);
  if (type === "recurring")
    return {
      type,
      cron: string(item.cron),
      timezone: string(item.timezone),
    };
  if (type === "once") return { type, runAt: string(item.runAt) };
  throw new IntegralError("invalid schedule trigger", 400);
}

function profile(value: unknown): CreateSchedule["profile"] {
  const item = record(value);
  return {
    connection: string(item.connection),
    provider: string(item.provider),
    model: string(item.model),
    piVersion: string(item.piVersion),
    piImage: string(item.piImage),
  };
}

async function bodyJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  return await readJsonObject(request, { invalidMessage: "invalid JSON body" });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IntegralError("expected an object", 400);
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new IntegralError("expected a non-empty string", 400);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function integer(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1)
    throw new IntegralError("expected a positive integer", 400);
  return Number(value);
}

function actor(body: Record<string, unknown>): string {
  return string(body.actor);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  writeJson(response, status, value);
}

function unauthorized(response: ServerResponse): void {
  response.writeHead(401).end("unauthorized\n");
}
