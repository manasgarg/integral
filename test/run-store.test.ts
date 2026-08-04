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

test("[RUN-01CA16F2] [RUN-79BACB0C] [RUN-770B8FFA] a history view is a stable read-only projection of finalized earlier runs", async (t) => {
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
  const view = await store.createHistoryView(current.runId),
    initialIndex = JSON.parse(await readFile(join(view, "index.json"), "utf8"));
  assert.deepEqual(
    initialIndex.runs.map((run: { runId: string }) => run.runId),
    [earlier.runId],
  );
  assert.deepEqual((await readdir(view)).sort(), [earlier.runId, "index.json"]);
  await assert.rejects(access(join(view, "index.json"), constants.W_OK));

  await current.finalize({ termination: "failed", error: "task failed" });
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
  const laterView = await store.createHistoryView(later.runId),
    laterIndex = JSON.parse(
      await readFile(join(laterView, "index.json"), "utf8"),
    );
  assert.deepEqual(
    laterIndex.runs.map((run: { runId: string }) => run.runId),
    [earlier.runId, current.runId],
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
    view = await recovered.createHistoryView(next.runId),
    index = JSON.parse(await readFile(join(view, "index.json"), "utf8")) as {
      runs: Array<{ runId: string }>;
    };
  assert.deepEqual(
    index.runs.map((item) => item.runId),
    [run.runId],
  );
  await recovered.removeHistoryView(view);
});
