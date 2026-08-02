import assert from "node:assert/strict";
import test from "node:test";
import { nextCronInstant, parseCron } from "../src/cron.ts";
import { ScheduleStore } from "../src/schedule-store.ts";
import { Scheduler } from "../src/scheduler.ts";
import { loadConfig } from "../src/config.ts";
import { scheduleCommand } from "../src/cli.ts";
import { fixture } from "./helpers.ts";

const profile = {
  connection: "model",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  piVersion: "1.2.3",
  piImage: "sha256:test",
};

test("[SCHEDULE-A1F47A7A] cron parsing uses five fields, IANA timezones, and real DST instants", () => {
  assert.throws(() => parseCron("* * * *"), /five fields/);
  assert.throws(
    () => nextCronInstant("* * * * *", "Not/AZone", Date.now()),
    /IANA timezone/,
  );

  const beforeSpring = Date.parse("2026-03-28T01:31:00Z");
  assert.equal(
    new Date(
      nextCronInstant("30 2 * * *", "Europe/Berlin", beforeSpring),
    ).toISOString(),
    "2026-03-30T00:30:00.000Z",
  );

  const beforeFall = Date.parse("2026-10-24T00:31:00Z"),
    first = nextCronInstant("30 2 * * *", "Europe/Berlin", beforeFall),
    second = nextCronInstant("30 2 * * *", "Europe/Berlin", first);
  assert.equal(new Date(first).toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(new Date(second).toISOString(), "2026-10-25T01:30:00.000Z");
});

test("[SCHEDULE-55BD779F] [SCHEDULE-22FF69D9] schedule mutations are revision-checked Git commits with restorable history", async (t) => {
  const paths = await fixture(t),
    now = Date.parse("2026-08-02T12:00:00Z"),
    store = new ScheduleStore(
      paths,
      undefined,
      () => now,
      () => "schedule-1",
    );
  await store.load();
  const created = await store.create(
    {
      trigger: {
        type: "recurring",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Berlin",
      },
      prompt: "prepare the daily report",
      profile,
    },
    "pi:session-1",
  );
  assert.equal(created.revision, 1);
  assert.equal(store.list().length, 1);

  const updated = await store.update(
    created.id,
    { expectedRevision: 1, prompt: "prepare and send the daily report" },
    "pi:session-1",
  );
  assert.equal(updated.revision, 2);
  await assert.rejects(
    store.update(
      created.id,
      { expectedRevision: 1, prompt: "stale" },
      "operator",
    ),
    /revision conflict/,
  );

  const deleted = await store.delete(created.id, 2, "operator");
  assert.equal(deleted.deleted, true);
  assert.equal(store.list().length, 0);
  const history = await store.history(created.id);
  assert.deepEqual(
    history.map((entry) => entry.operation),
    ["create", "update", "delete"],
  );
  assert.deepEqual(
    history.map((entry) => entry.actor),
    ["pi:session-1", "pi:session-1", "operator"],
  );

  const restored = await store.restore(
    created.id,
    history[0]!.commit,
    3,
    "operator",
  );
  assert.equal(restored.revision, 4);
  assert.equal(restored.prompt, "prepare the daily report");
  assert.equal(restored.deleted, false);

  const reloaded = new ScheduleStore(paths, undefined, () => now);
  await reloaded.load();
  assert.deepEqual(reloaded.get(created.id), restored);
});

test("[SCHEDULE-E141FFD9] schedule CLI exposes definition history, run history, mutations, and cancellation", async (t) => {
  const paths = await fixture(t),
    output: string[] = [],
    requests: Array<{ path: string; method: string }> = [],
    dependencies = {
      resolvePaths: () => paths,
      componentEndpoint: async (
        _paths: typeof paths,
        component: "coordinator" | "runner" | "gateway" | "scheduler",
      ) => `http://${component}.test`,
      verifiedFetch: async () => Response.json({ status: "ready" }),
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input
              : input.url,
        );
        requests.push({
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
        });
        if (url.pathname.endsWith("/history"))
          return Response.json([
            { commit: "abc", revision: 1, operation: "create" },
          ]);
        if (url.pathname === "/integral/occurrences")
          return Response.json([
            { executionId: "execution-1", state: "failed" },
          ]);
        if (url.pathname.endsWith("/cancel"))
          return Response.json({ id: "execution-1", state: "cancelled" });
        return Response.json({
          id: "schedule-1",
          revision: 2,
          enabled: false,
        });
      },
      writeOutput: (text: string) => output.push(text),
    };

  await scheduleCommand(["history", "schedule-1", "--json"], dependencies);
  await scheduleCommand(["runs", "schedule-1", "--json"], dependencies);
  await scheduleCommand(
    ["disable", "schedule-1", "--revision", "1", "--json"],
    dependencies,
  );
  await scheduleCommand(["cancel", "execution-1", "--json"], dependencies);

  assert.ok(requests.some((item) => item.path.endsWith("/history")));
  assert.ok(
    requests.some(
      (item) => item.path === "/integral/occurrences?scheduleId=schedule-1",
    ),
  );
  assert.ok(
    requests.some(
      (item) => item.path.endsWith("/disable") && item.method === "POST",
    ),
  );
  assert.ok(requests.some((item) => item.path.endsWith("/cancel")));
  assert.match(output.join(""), /execution-1/);
});

test("[SCHEDULE-55BD779F] invalid or stale schedule mutations do not enter definition history", async (t) => {
  const paths = await fixture(t),
    now = Date.parse("2026-08-02T12:00:00Z"),
    store = new ScheduleStore(
      paths,
      undefined,
      () => now,
      () => "schedule-2",
    );
  await store.load();
  await assert.rejects(
    store.create(
      {
        trigger: { type: "once", runAt: "2026-08-01T12:00:00Z" },
        prompt: "too late",
        profile,
      },
      "operator",
    ),
    /future instant/,
  );
  assert.deepEqual(store.list(), []);
});

test("[SCHEDULE-A1F47A7A] [SCHEDULE-52697825] [SCHEDULE-8912B5E6] scheduler coalesces missed ticks and dispatches the latest occurrence idempotently", async (t) => {
  const paths = await fixture(t),
    base = await loadConfig(paths, {}),
    config = { ...base, server: { ...base.server, schedulerPort: 0 } };
  let now = Date.parse("2026-08-02T12:00:30Z");
  const dispatches: string[] = [],
    scheduler = new Scheduler(paths, config, {
      now: () => now,
      servers: {
        async listen() {},
        async close() {},
      },
      intervals: {
        setInterval() {
          return {};
        },
        clearInterval() {},
      },
      async internalFetch(_paths, caller, target, path) {
        assert.equal(caller, "scheduler");
        assert.equal(target, "coordinator");
        dispatches.push(path);
        return Response.json({ id: `task-${dispatches.length}` });
      },
    });
  await scheduler.start();
  await scheduler.schedules.create(
    {
      trigger: { type: "recurring", cron: "* * * * *", timezone: "UTC" },
      prompt: "tick",
      profile,
    },
    "operator",
  );

  now = Date.parse("2026-08-02T12:03:30Z");
  await scheduler.tick();
  await scheduler.tick();

  const occurrences = scheduler.occurrences.snapshot();
  assert.deepEqual(
    occurrences.map((item) => [item.scheduledFor, item.state]),
    [
      ["2026-08-02T12:01:00.000Z", "coalesced"],
      ["2026-08-02T12:02:00.000Z", "coalesced"],
      ["2026-08-02T12:03:00.000Z", "accepted"],
    ],
  );
  assert.equal(dispatches.length, 1);
  assert.equal(occurrences[2]!.dispatchAttempts, 1);
  await scheduler.stop();
});
