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

/* @covers SCHEDULE-A1F47A7A
Given an enabled schedule reaches its next execution instant
	When the scheduler evaluates due work
		Then it durably creates an occurrence before dispatching it
			And derives a stable execution ID from the schedule ID, schedule revision, and scheduled UTC instant
			And snapshots the task prompt and immutable Pi execution profile into the occurrence
			And never creates a second logical occurrence for the same execution ID after restart or clock rollback
			And calculates the next recurring instant using the schedule's IANA timezone and defined daylight-saving behavior
*/
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

/* @covers SCHEDULE-22FF69D9
Given the scheduler owns a private Git repository under the deployment data directory
	When it accepts creation, update, enable, disable, deletion, or restoration of a schedule
		Then it writes the canonical schedule definition or deletion to that repository
			And creates one commit identifying the schedule ID, revision, operation, timestamp, and authenticated actor
			And acknowledges the mutation only after the commit is durable
			And serializes concurrent mutations into one commit order
			And never commits component credentials, gateway session identities, occurrence state, task output, or attempt records
	When a mutation is interrupted before its commit becomes durable
		Then the scheduler recovers the last committed definition state
			And does not expose the incomplete revision as current
	When a user inspects a schedule's definition history
		Then integral returns its committed revisions in order, including deleted definitions
	When a user restores a prior definition revision
		Then integral commits that definition as a new current revision
			And does not rewrite or remove the intervening history
*/
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

/* @covers SCHEDULE-E141FFD9
Given schedules and task occurrences exist in any state
	When the user runs the schedule list, show, or run-history command
		Then integral reports stable schedule and execution IDs, trigger type, state, scheduled instant, and attempt history
			And JSON output represents the same information structurally
	When the user runs the schedule definition-history command
		Then integral reports the Git-backed definition revisions separately from occurrence run history
			And can show the canonical definition at a requested revision
	When the user disables or enables a schedule from the CLI
		Then integral applies the same durable schedule mutation used by Pi
	When the user cancels an active one-time task
		Then integral requires an explicit execution ID
			And records the operator action durably without deleting execution history
	When the user requests another attempt for a failed recurring occurrence
		Then integral rejects the request
			And leaves the failed occurrence terminal
			And identifies the next schedule occurrence as the way recurring work runs again
*/
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

/* @covers SCHEDULE-52697825
Given the scheduler has a due occurrence not yet accepted by the coordinator
	When it submits that execution ID to the coordinator
		Then the coordinator durably accepts one task-queue record for that execution ID
			And returns that same record when an identical submission is repeated
			And rejects a repeated execution ID whose immutable task data differs
			And the scheduler retries unavailable or ambiguous delivery without creating duplicate logical work
*/
/* @covers SCHEDULE-8912B5E6
Given an enabled recurring schedule passes more than one execution instant while scheduling is unavailable
	When the scheduler recovers
		Then it creates only the latest missed occurrence
			And records the earlier missed instants as coalesced for inspection
			And does not silently present coalesced instants as successfully executed
			And resumes calculation from the schedule's next future instant
*/
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
