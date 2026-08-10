import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { RunStore, type RunEvent } from "../src/run-store.ts";
import { fixture } from "./helpers.ts";

const selection = {
  connection: "model",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  piVersion: "1.2.3",
  piImage: "sha256:pi",
};

/* @covers RUN-B1D837E0
Given the runner is about to start a warm interactive Pi session or an isolated scheduled-task attempt
	When integral assigns the container a run identity
		Then it creates a durable run record under `<INTEGRAL_HOME>/data/runs/<run-id>` before starting Pi
			And records whether the run is interactive or scheduled
			And records its immutable model and Pi runtime identity
			And records its start time and applicable schedule, execution, and attempt identities
	When integral supplies input to Pi or receives agent output during that run
		Then it appends the input, assistant output, and tool activity needed to reconstruct the run
			And preserves their observed order
	When the run ends for any reason
		Then integral durably records the finish time and host-observed termination reason
			And records the declared task outcome when one exists without treating it as host-attested success
			And finalizes the record before removing the temporary session home
	When integral recovers a record whose run did not reach finalization
		Then it marks the run interrupted with the available host evidence
			And does not invent a successful outcome
*/
/* @covers RUN-88706C0D
Given integral is recording a run
	When it records the run's identity and operating conditions
		Then it records the run ID, run kind, parent or prior-attempt run IDs when applicable, model provider and model, Pi runtime identity, start time, finish time, and elapsed time
			And records the configured turn, idle, and task ceilings that applied
			And records schedule, execution, attempt, and retry numbers when applicable
	When a turn occurs
		Then it records the complete agent-visible input and output in observed order
			And records whether input was an original request, follow-up, steering message, retry instruction, or task-outcome reminder
			And records each tool name, redacted agent-visible arguments, redacted result, status, error, and elapsed time
			And records failed commands, failed validations, refused gateway operations, timeouts, cancellations, and task outcome declarations as typed events
			And gives each event a stable identity that summaries can reference
	When the model provider reports usage for a turn
		Then integral preserves the provider's usage categories
			And normalizes available input, output, cache-read, cache-write or cache-creation, reasoning, and total token counts
			And records available monetary cost and currency without estimating missing cost
			And counts every provider-reported request exactly once, including a retry that consumed tokens
			And aggregates each available usage category for the complete run
			And reports cache reuse as a ratio when it can be calculated from reported counts
	When the provider omits a usage category
		Then integral records that category as unavailable rather than zero
			And does not estimate tokens from text length
	When the user corrects, redirects, rejects, or retries earlier work
		Then integral records that feedback as an event in the run where it was received
			And links it to the earlier run or event when the relationship is known
			And does not rewrite the finalized earlier run
	When integral finalizes the run
		Then it writes a machine-readable learning-signal summary beside the ordered activity
			And summarizes objective counts and references for tool failures, command failures, validation failures, denied operations, timeouts, cancellations, retries, steering, user corrections, and outcome status
			And includes the run-level token, cache, cost, and elapsed-time aggregates
			And distinguishes host-observed facts, provider-reported values, user feedback, and agent declarations
			And does not infer an unobserved mistake, quality score, or cause
			And does not store or expose private provider reasoning that was not part of the agent-visible protocol
*/
test("[RUN-B1D837E0] [RUN-88706C0D] finalized runs retain ordered evidence, redacted failures, and provider usage signals", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  let time = Date.parse("2026-08-04T12:00:00.000Z"),
    id = 0;
  const store = new RunStore(
    paths,
    () => time,
    () => `identifier-${++id}`,
  );
  await store.initialize();
  const run = await store.begin({
    kind: "interactive",
    sessionId: "session-1",
    model: selection,
    config,
    sensitiveValues: ["session-secret"],
  });
  await run.input("please inspect this", "original-request");
  run.protocol({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "exec",
  });
  time += 150;
  run.protocol({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "exec",
    arguments: { authorization: "Bearer real-secret" },
    result: { exitCode: 1, stderr: "tests failed with session-secret" },
  });
  run.protocol({
    type: "tool_execution_end",
    toolCallId: "tool-2",
    toolName: "http",
    result: { status: "denied", error: "gateway policy denied request" },
  });
  run.protocol({
    type: "message_end",
    message: {
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 10,
        reasoning_tokens: 5,
        total_tokens: 200,
        cost: 0.02,
        currency: "USD",
      },
    },
  });
  await run.output("I found the failure.");
  time += 2_000;
  await run.finalize({ termination: "completed" });

  const directory = join(paths.runs, run.runId),
    metadata = JSON.parse(await readFile(join(directory, "run.json"), "utf8")),
    events = (await readFile(join(directory, "activity.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RunEvent),
    signals = JSON.parse(
      await readFile(join(directory, "signals.json"), "utf8"),
    );
  assert.equal(metadata.status, "finalized");
  assert.equal(metadata.elapsedMs, 2_150);
  assert.equal(metadata.termination, "completed");
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /real-secret|session-secret/);
  assert.match(serialized, /\[redacted\]/);
  assert.equal(signals.counts["tool-start"], 1);
  assert.equal(signals.counts["tool-result"], 2);
  assert.equal(signals.counts["tool-failure"], 2);
  assert.equal(signals.counts["command-failure"], 1);
  assert.equal(signals.counts["validation-failure"], 1);
  assert.equal(signals.counts["denied-operation"], 1);
  assert.equal(
    (
      events.find((event) => event.type === "tool-result")!.data as {
        elapsedMs: number;
      }
    ).elapsedMs,
    150,
  );
  assert.equal(signals.usage.requestCount, 1);
  assert.equal(signals.usage.inputTokens, 100);
  assert.equal(signals.usage.outputTokens, 25);
  assert.equal(signals.usage.cacheReadTokens, 60);
  assert.equal(signals.usage.cacheWriteTokens, 10);
  assert.equal(signals.usage.reasoningTokens, 5);
  assert.equal(signals.usage.totalTokens, 200);
  assert.equal(signals.usage.cacheReuseRatio, 0.375);
  assert.deepEqual(signals.usage.costs, [{ amount: 0.02, currency: "USD" }]);
  assert.deepEqual(signals.usage.unavailable, []);
});

/* @covers RUN-770B8FFA
Given integral has selected the finalized runs visible to a new agent environment
	When another run finishes while that agent is still active
		Then the active agent's finalized-runs index and `$HOME/history/runs` snapshot do not change
			And a later agent environment includes the newly finalized run
	When the current run writes evidence or reaches its outcome
		Then only `$HOME/history/current` changes in that environment
			And the run appears under `$HOME/history/runs/<run-id>` only in agent environments prepared after finalization
Given integral restarts with an existing durable run archive
	When it prepares the next agent environment
		Then the environment receives the same finalized history as before the restart
			And temporary session-home cleanup does not remove that history
*/
test("[RUN-01CA16F2] [RUN-79BACB0C] [RUN-770B8FFA] a history view combines stable finalized runs with a live current-run projection", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  let id = 0;
  const store = new RunStore(
    paths,
    () => 1_700_000_000_000,
    () => `run-${++id}`,
  );
  await store.initialize();
  const earlier = await store.begin({
    kind: "interactive",
    sessionId: "earlier",
    model: selection,
    config,
  });
  await earlier.output("earlier output");
  await earlier.finalize({ termination: "completed" });
  const current = await store.begin({
    kind: "scheduled",
    sessionId: "current",
    model: selection,
    config,
    executionId: "execution-1",
  });
  const view = await store.createHistoryView(current),
    initialIndex = JSON.parse(await readFile(join(view, "index.json"), "utf8"));
  assert.deepEqual(
    initialIndex.runs.map((run: { runId: string }) => run.runId),
    [earlier.runId],
  );
  assert.deepEqual((await readdir(view)).sort(), [
    "current",
    "index.json",
    "runs",
  ]);
  assert.deepEqual(await readdir(join(view, "runs")), [earlier.runId]);
  await assert.rejects(access(join(view, "index.json"), constants.W_OK));

  await current.input("inspect this run", "original-request");
  current.protocol({
    type: "message_end",
    message: { usage: { input: 20, output: 5, cacheRead: 10 } },
  });
  await current.output("current output");
  const runningMetadata = JSON.parse(
      await readFile(join(view, "current", "run.json"), "utf8"),
    ),
    runningActivity = await readFile(
      join(view, "current", "activity.jsonl"),
      "utf8",
    ),
    runningSignals = JSON.parse(
      await readFile(join(view, "current", "signals.json"), "utf8"),
    );
  assert.equal(runningMetadata.status, "running");
  assert.match(runningActivity, /inspect this run/);
  assert.match(runningActivity, /current output/);
  assert.equal(runningSignals.usage.inputTokens, 20);
  assert.equal(runningSignals.usage.outputTokens, 5);
  assert.equal(runningSignals.usage.cacheReadTokens, 10);
  assert.equal(runningSignals.outcome, undefined);

  await current.finalize({ termination: "failed", error: "task failed" });
  const finalCurrentMetadata = JSON.parse(
      await readFile(join(view, "current", "run.json"), "utf8"),
    ),
    finalCurrentSignals = JSON.parse(
      await readFile(join(view, "current", "signals.json"), "utf8"),
    );
  assert.equal(finalCurrentMetadata.status, "finalized");
  assert.equal(finalCurrentMetadata.termination, "failed");
  assert.equal(finalCurrentSignals.outcome, "failed");
  assert.deepEqual(
    (await store.finalizedForExecution("execution-1")).map((run) => run.runId),
    [current.runId],
  );
  assert.equal(
    (await store.latestFinalized("interactive"))?.runId,
    earlier.runId,
  );
  const stableIndex = JSON.parse(
    await readFile(join(view, "index.json"), "utf8"),
  );
  assert.deepEqual(stableIndex, initialIndex);
  const later = await store.begin({
    kind: "interactive",
    sessionId: "later",
    model: selection,
    config,
  });
  const laterView = await store.createHistoryView(later),
    laterIndex = JSON.parse(
      await readFile(join(laterView, "index.json"), "utf8"),
    );
  assert.deepEqual(
    laterIndex.runs.map((run: { runId: string }) => run.runId),
    [earlier.runId, current.runId],
  );
  assert.deepEqual(
    (await readdir(join(laterView, "runs"))).sort(),
    [earlier.runId, current.runId].sort(),
  );
  await store.removeHistoryView(view);
  await store.removeHistoryView(laterView);
});

test("[RUN-B1D837E0] unfinished records become interrupted during recovery", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    store = new RunStore(
      paths,
      () => 1_700_000_000_000,
      () => crypto.randomUUID(),
    );
  await store.initialize();
  const run = await store.begin({
    kind: "interactive",
    sessionId: "abandoned",
    model: selection,
    config,
  });
  await run.input("unfinished", "original-request");

  const recovered = new RunStore(
    paths,
    () => 1_700_000_005_000,
    () => crypto.randomUUID(),
  );
  await recovered.initialize();

  const metadata = JSON.parse(
    await readFile(join(paths.runs, run.runId, "run.json"), "utf8"),
  ) as { status: string; termination: string; error: string };
  assert.equal(metadata.status, "finalized");
  assert.equal(metadata.termination, "interrupted");
  assert.match(metadata.error, /restarted/);
  const events = (
    await readFile(join(paths.runs, run.runId, "activity.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
  assert.deepEqual(
    events.map((event) => [event.sequence, event.type]),
    [
      [1, "input"],
      [2, "interrupted"],
    ],
  );
  const next = await recovered.begin({
      kind: "interactive",
      sessionId: "next",
      model: selection,
      config,
    }),
    view = await recovered.createHistoryView(next),
    index = JSON.parse(await readFile(join(view, "index.json"), "utf8")) as {
      runs: Array<{ runId: string }>;
    };
  assert.deepEqual(
    index.runs.map((item) => item.runId),
    [run.runId],
  );
  await recovered.removeHistoryView(view);
});
