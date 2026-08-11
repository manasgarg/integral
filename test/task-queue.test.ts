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

/* @covers SCHEDULE-E85BDCAD
Given a recurring occurrence has been durably accepted by the coordinator
	When delivery or capacity fails before its isolated Pi container starts
		Then integral keeps the occurrence pending for an execution attempt
	When its isolated Pi container starts and the attempt does not complete successfully
		Then the coordinator durably marks that occurrence failed
			And does not return it to the active task queue
			And acknowledges the terminal failure to the scheduler
			And retains the failed occurrence and attempt for inspection
	When the runner or coordinator recovers an occurrence recorded as running with an unknown outcome
		Then it marks that recurring occurrence failed rather than executing it again
	When the schedule reaches its next recurring instant after an earlier occurrence failed
		Then the scheduler creates the next independent occurrence normally
			And the earlier failure does not delay or replace it
*/
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

/* @covers SCHEDULE-4205553B
Given a one-time task has not completed successfully
	When delivery fails or an isolated execution attempt is unsuccessful
		Then integral retains the same logical execution ID in the active task queue
			And records the unsuccessful attempt separately
			And schedules another attempt with capped backoff
			And uses a fresh attempt ID, temporary home, gateway identity, and container for that attempt
	When the runner or coordinator recovers the one-time task with an unknown in-flight outcome
		Then it returns the same logical execution ID to pending state for another isolated attempt
	When Pi completes the task and exits cleanly
		Then integral clears the task from the active queue only after durable completion
	When an operator explicitly cancels the task
		Then integral records cancellation as the only non-successful terminal outcome
			And retains its execution and attempt history for inspection
*/
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
  await queue.declareOutcome(
    "execution-o",
    second.attempts[1]!.attemptId,
    "complete",
    "done",
  );
  const completed = await queue.finalize(
    "execution-o",
    second.attempts[1]!.attemptId,
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

/* @covers SCHEDULE-42E63F16
Given the coordinator has durably completed a task or terminally failed a recurring occurrence
	When scheduler acknowledgement is unavailable or its response is lost
		Then the coordinator retains the acknowledgement in a durable outbox
			And retries the same execution ID and outcome after component restart
			And the scheduler applies repeated identical acknowledgements without changing the recorded outcome
			And neither component causes the task to execute again because acknowledgement was repeated
*/
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
  await queue.declareOutcome(
    "execution",
    running.attempts[0]!.attemptId,
    "complete",
    "done",
  );
  await assert.rejects(
    queue.declareOutcome(
      "execution",
      running.attempts[0]!.attemptId,
      "failed",
      "different",
    ),
    /conflicting outcome declaration/,
  );
  await queue.finalize("execution", running.attempts[0]!.attemptId, 0);
  await queue.finalize("execution", running.attempts[0]!.attemptId, 0);
  await queue.declareOutcome(
    "execution",
    running.attempts[0]!.attemptId,
    "complete",
    "done",
  );
  assert.equal(queue.outbox().length, 1);
  await queue.acknowledgeOutbox("execution");
  await queue.acknowledgeOutbox("execution");
  const restored = new DurableTaskQueue(paths);
  await restored.load();
  assert.deepEqual(restored.outbox(), []);
  assert.equal(restored.snapshot()[0]!.state, "completed");
});

test("[SCHEDULE-930581F7] clean exit finalizes Pi's declared failure and rejects success without a declaration", async (t) => {
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
  await queue.accept(occurrence("execution-failed", "recurring"));
  const failedClaim = await queue.claim(),
    failed = await queue.start("execution-failed", failedClaim!.claimId!),
    failedAttempt = failed.attempts[0]!.attemptId;
  await queue.declareOutcome(
    "execution-failed",
    failedAttempt,
    "failed",
    "mail provider rejected the message",
  );
  const finalizedFailure = await queue.finalize(
    "execution-failed",
    failedAttempt,
    0,
  );
  assert.equal(finalizedFailure.state, "failed");
  assert.equal(
    finalizedFailure.lastError,
    "mail provider rejected the message",
  );

  await queue.accept(occurrence("execution-missing", "once"));
  const missingClaim = await queue.claim(),
    missing = await queue.start("execution-missing", missingClaim!.claimId!),
    finalizedMissing = await queue.finalize(
      "execution-missing",
      missing.attempts[0]!.attemptId,
      0,
    );
  assert.equal(finalizedMissing.state, "retry-wait");
  assert.match(finalizedMissing.lastError!, /without declaring/);
});

/* @covers SCHEDULE-FDFA799E
Given one occurrence of a recurring schedule is running
	When another occurrence of that schedule becomes due
		Then the scheduler may materialize the later occurrence durably
			And the coordinator does not start it before the running occurrence reaches a terminal outcome
			And work from other schedules and interactive talk remains eligible to run
*/
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
