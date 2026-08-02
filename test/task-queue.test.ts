import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledOccurrence } from "../src/occurrence-store.ts";
import { DurableTaskQueue } from "../src/task-queue.ts";
import { fixture } from "./helpers.ts";

function occurrence(
  executionId: string,
  triggerType: "recurring" | "once",
): ScheduledOccurrence {
  return {
    executionId,
    scheduleId: `schedule-${triggerType}`,
    scheduleRevision: 1,
    triggerType,
    scheduledFor: "2026-08-02T12:00:00.000Z",
    prompt: "perform work",
    profile: {
      connection: "model",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      piVersion: "1.2.3",
      piImage: "sha256:test",
    },
    state: "pending",
    dispatchAttempts: 1,
    createdAt: "2026-08-02T12:00:00.000Z",
  };
}

test("[SCHEDULE-52697825] coordinator acceptance is idempotent and rejects conflicting immutable task data", async (t) => {
  const paths = await fixture(t),
    queue = new DurableTaskQueue(paths);
  await queue.load();
  const input = occurrence("execution-1", "once"),
    first = await queue.accept(input),
    repeated = await queue.accept(input);
  assert.deepEqual(repeated, first);
  await assert.rejects(
    queue.accept({ ...input, prompt: "different" }),
    /conflicts with accepted task/,
  );
  assert.equal(queue.snapshot().length, 1);
});

test("[SCHEDULE-E85BDCAD] a recurring occurrence receives one execution attempt and terminal failure acknowledgement", async (t) => {
  const paths = await fixture(t);
  let now = Date.parse("2026-08-02T12:00:00Z");
  let id = 0;
  const queue = new DurableTaskQueue(
    paths,
    () => now,
    () => `id-${++id}`,
  );
  await queue.load();
  await queue.accept(occurrence("execution-r", "recurring"));
  const claimed = await queue.claim(),
    running = await queue.start("execution-r", claimed!.claimId!);
  assert.equal(running.state, "running");
  now += 1_000;
  const failed = await queue.fail(
    "execution-r",
    running.attempts[0]!.attemptId,
    "Pi exited non-zero",
    1,
  );
  assert.equal(failed.state, "failed");
  assert.equal(await queue.claim(), undefined);
  assert.deepEqual(
    queue.outbox().map((item) => item.outcome),
    ["failed"],
  );
});

test("[SCHEDULE-4205553B] [SCHEDULE-930581F7] a one-time task retries in a fresh attempt until clean exit zero", async (t) => {
  const paths = await fixture(t);
  let now = Date.parse("2026-08-02T12:00:00Z"),
    attempt = 0;
  const queue = new DurableTaskQueue(
    paths,
    () => now,
    () => `id-${++attempt}`,
  );
  await queue.load();
  await queue.accept(occurrence("execution-o", "once"));
  const firstClaim = await queue.claim(),
    first = await queue.start("execution-o", firstClaim!.claimId!);
  await queue.fail("execution-o", first.attempts[0]!.attemptId, "timeout");
  assert.equal(queue.snapshot()[0]!.state, "retry-wait");
  assert.equal(await queue.claim(), undefined);

  now += 5_000;
  const secondClaim = await queue.claim(),
    second = await queue.start("execution-o", secondClaim!.claimId!);
  assert.equal(second.attempts.length, 2);
  assert.notEqual(second.attempts[0]!.attemptId, second.attempts[1]!.attemptId);
  await assert.rejects(
    queue.complete("execution-o", second.attempts[1]!.attemptId, "partial", 1),
    /exit code zero/,
  );
  const completed = await queue.complete(
    "execution-o",
    second.attempts[1]!.attemptId,
    "done",
    0,
  );
  assert.equal(completed.state, "completed");
  assert.equal(completed.result, "done");
  assert.deepEqual(
    queue.outbox().map((item) => item.outcome),
    ["succeeded"],
  );
});

test("[SCHEDULE-E85BDCAD] [SCHEDULE-4205553B] restart resolves unknown running outcomes by trigger type", async (t) => {
  const paths = await fixture(t),
    queue = new DurableTaskQueue(
      paths,
      () => Date.parse("2026-08-02T12:00:00Z"),
      (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    );
  await queue.load();
  await queue.accept(occurrence("execution-r", "recurring"));
  const recurringClaim = await queue.claim();
  await queue.start("execution-r", recurringClaim!.claimId!);

  const recovered = new DurableTaskQueue(paths, () =>
    Date.parse("2026-08-02T12:01:00Z"),
  );
  await recovered.load();
  assert.equal(recovered.snapshot()[0]!.state, "failed");
  assert.equal(recovered.outbox()[0]!.outcome, "failed");

  const oncePaths = await fixture(t),
    once = new DurableTaskQueue(
      oncePaths,
      undefined,
      (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    );
  await once.load();
  await once.accept(occurrence("execution-o", "once"));
  const onceClaim = await once.claim();
  await once.start("execution-o", onceClaim!.claimId!);
  const onceRecovered = new DurableTaskQueue(oncePaths);
  await onceRecovered.load();
  assert.equal(onceRecovered.snapshot()[0]!.state, "queued");
  assert.deepEqual(onceRecovered.outbox(), []);
});

test("[SCHEDULE-42E63F16] successful outbox acknowledgement is durable and idempotent", async (t) => {
  const paths = await fixture(t),
    queue = new DurableTaskQueue(
      paths,
      undefined,
      (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    );
  await queue.load();
  await queue.accept(occurrence("execution", "once"));
  const claim = await queue.claim(),
    running = await queue.start("execution", claim!.claimId!);
  await queue.complete("execution", running.attempts[0]!.attemptId, "done", 0);
  await assert.rejects(
    queue.complete("execution", running.attempts[0]!.attemptId, "different", 0),
    /different result/,
  );
  assert.equal(queue.outbox().length, 1);
  await queue.acknowledgeOutbox("execution");
  await queue.acknowledgeOutbox("execution");
  const restored = new DurableTaskQueue(paths);
  await restored.load();
  assert.deepEqual(restored.outbox(), []);
  assert.equal(restored.snapshot()[0]!.state, "completed");
});

test("[SCHEDULE-FDFA799E] a later occurrence cannot overlap a running occurrence", async (t) => {
  const paths = await fixture(t);
  let id = 0;
  const queue = new DurableTaskQueue(paths, undefined, () => `id-${++id}`);
  await queue.load();
  const first = occurrence("execution-1", "recurring"),
    second = {
      ...occurrence("execution-2", "recurring"),
      scheduledFor: "2026-08-02T12:01:00.000Z",
    };
  await queue.accept(first);
  await queue.accept(second);
  const claim = await queue.claim(),
    running = await queue.start(first.executionId, claim!.claimId!);
  assert.equal(await queue.claim(), undefined);
  await queue.fail(first.executionId, running.attempts[0]!.attemptId, "failed");
  assert.equal((await queue.claim())?.executionId, second.executionId);
});
