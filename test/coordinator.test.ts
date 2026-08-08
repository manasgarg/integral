import assert from "node:assert/strict";
import test from "node:test";
import { Coordinator, type ClientEvent } from "../src/coordinator.ts";
import { loadConfig } from "../src/config.ts";
import { fixture } from "./helpers.ts";
import { saveConnection, validateConnection } from "../src/connections.ts";
import { Logger } from "../src/logging.ts";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

function waitingResponse(): ServerResponse & EventEmitter {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
  }) as ServerResponse & EventEmitter;
}

async function coordinatorFixture(
  t: test.TestContext,
): Promise<{ coordinator: Coordinator; events: ClientEvent[] }> {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    events: ClientEvent[] = [];
  const coordinator = new Coordinator(paths, config);
  await coordinator.queue.load();
  await coordinator.conversation.load();
  const internals = coordinator as any;
  internals.events.on("event", (event: ClientEvent) => events.push(event));
  return { coordinator, events };
}

test("[CHAT-54B8A1C3] [CHAT-93E7D20B] every attachment is a view over one coordinator-owned conversation and queue snapshot", async (t) => {
  const { coordinator } = await coordinatorFixture(t);
  const item = await coordinator.queue.enqueue("hello");
  await coordinator.conversation.append({
    type: "user",
    messageId: item.id,
    text: item.text,
  });
  const a = (coordinator as any).snapshot(),
    b = (coordinator as any).snapshot();
  assert.deepEqual(a.conversation, b.conversation);
  assert.equal(a.queue[0].id, item.id);
  assert.equal(b.queue[0].id, item.id);
});

test("[CHAT-D7E2F609] [QUEUE-5B7C2E91] queue changes broadcast one identical persisted event to every listener", async (t) => {
  const { coordinator, events } = await coordinatorFixture(t);
  const seenA: ClientEvent[] = [],
    seenB: ClientEvent[] = [],
    internals = coordinator as any;
  internals.events.on("event", (e: ClientEvent) => seenA.push(e));
  internals.events.on("event", (e: ClientEvent) => seenB.push(e));
  const item = await coordinator.queue.enqueue("shared");
  assert.equal(events[0]?.type, "queue.queued");
  assert.equal((events[0]?.data as any).message.id, item.id);
  assert.deepEqual(seenA, seenB);
});

test("[CHAT-888AFAE0] [CHAT-D7E2F609] user broadcasts identify their originating terminal without persisting it", async (t) => {
  const { coordinator, events } = await coordinatorFixture(t),
    internals = coordinator as any,
    item = await internals.submitMessage("hello", "terminal-a"),
    persisted = coordinator.conversation.snapshot().at(-1),
    broadcast = events.find((event) => event.type === "conversation.user");

  assert.equal(persisted?.messageId, item.id);
  assert.equal("terminalId" in persisted!, false);
  assert.equal((broadcast?.data as any).terminalId, "terminal-a");
  assert.equal((broadcast?.data as any).messageId, item.id);
});

test("[CHAT-6E91B4C7] [CHAT-C53A90D2] model choices are validated, persisted, broadcast, and locked during an in-flight turn", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    choices = [
      {
        connection: "work",
        provider: "openai-codex",
        model: "gpt-5.5",
        piVersion: "1.2.3",
        piImage: "sha256:new",
      },
      {
        connection: "personal",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        piVersion: "1.2.3",
        piImage: "sha256:new",
      },
    ],
    discoveries = { count: 0 },
    coordinator = new Coordinator(paths, config, {
      async listModelChoices() {
        discoveries.count++;
        return { choices, piVersion: "1.2.3" };
      },
    }),
    events: ClientEvent[] = [],
    internals = coordinator as any;
  internals.events.on("event", (event: ClientEvent) => events.push(event));
  const menu = await coordinator.modelMenu();
  assert.deepEqual(menu, {
    choices,
    current: null,
    piVersion: "1.2.3",
  });
  const selected = choices[0]!;
  await assert.rejects(
    coordinator.selectConversationModel("missing", "missing"),
    /no longer available/,
  );
  assert.deepEqual(
    await coordinator.selectConversationModel(
      selected.connection,
      selected.model,
    ),
    selected,
  );
  assert.deepEqual(internals.snapshot().modelSelection, selected);
  assert.equal(events.at(-1)?.type, "conversation.selection");
  assert.equal(discoveries.count, 1);

  await saveConnection(
    paths,
    validateConnection({
      name: "new-model-connection",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "secret",
  );
  await coordinator.modelMenu();
  assert.equal(discoveries.count, 2);

  await coordinator.queue.enqueue("busy");
  await coordinator.queue.claim();
  await assert.rejects(
    coordinator.selectConversationModel(
      choices[1]!.connection,
      choices[1]!.model,
    ),
    /turn is in flight/,
  );
  assert.deepEqual(coordinator.modelSelection.get(), selected);

  const restored = new Coordinator(paths, config, {
    async listModelChoices() {
      return { choices, piVersion: "1.2.3" };
    },
  });
  await restored.modelSelection.load();
  assert.deepEqual(restored.modelSelection.get(), selected);
});

test("[BOX-40521095] package changes rebuild the selected exact Pi image and persist its identity", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    builds: Array<{
      version: string;
      packages: readonly string[];
      rebuild: boolean;
    }> = [],
    coordinator = new Coordinator(paths, config, {
      ensureImage(_config, version, options) {
        builds.push({
          version,
          packages: options.systemPackages,
          rebuild: options.rebuild,
        });
        return `sha256:packages-${builds.length}`;
      },
    });
  await coordinator.modelSelection.set({
    connection: "work",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "9.8.7",
    piImage: "sha256:base",
  });
  assert.deepEqual(await coordinator.containerPackageInventory(), {
    revision: 0,
    packages: ["ca-certificates", "gh", "git"],
    piVersion: "9.8.7",
    piImage: "sha256:base",
  });
  const installed = await coordinator.changeContainerPackages({
    operation: "install",
    packages: ["jq"],
    expectedRevision: 0,
    actor: "pi:session-1",
    approvalId: "approval-install",
  });
  assert.deepEqual(installed, {
    revision: 1,
    packages: ["ca-certificates", "gh", "git", "jq"],
    piVersion: "9.8.7",
    piImage: "sha256:packages-1",
  });
  assert.deepEqual(builds, [
    {
      version: "9.8.7",
      packages: ["ca-certificates", "gh", "git", "jq"],
      rebuild: true,
    },
  ]);
  assert.equal(coordinator.modelSelection.get()?.piImage, "sha256:packages-1");
  const upgraded = await coordinator.changeContainerPackages({
    operation: "upgrade",
    packages: ["jq"],
    expectedRevision: 1,
    actor: "pi:session-1",
    approvalId: "approval-upgrade",
  });
  assert.equal(upgraded.revision, 2);
  assert.equal(upgraded.piImage, "sha256:packages-2");
  assert.equal(builds.length, 2);
  const recovered = await coordinator.changeContainerPackages({
    operation: "upgrade",
    packages: ["jq"],
    expectedRevision: 1,
    actor: "approval:approval-upgrade",
    approvalId: "approval-upgrade",
  });
  assert.equal(recovered.revision, 2);
  assert.equal(builds.length, 3);
  assert.equal(builds[2]?.rebuild, false);
});

test("[GATEWAY-846B1000] a live Pi package request waits for an attached human and returns the durable result", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    builds: string[] = [],
    coordinator = new Coordinator(paths, config, {
      ensureImage: () => {
        builds.push("build");
        return "sha256:approved-image";
      },
    }),
    selection = {
      connection: "work",
      provider: "openai-codex",
      model: "gpt-5.5",
      piVersion: "1.2.3",
      piImage: "sha256:base",
    },
    response = waitingResponse();
  await coordinator.modelSelection.set(selection);
  const waiting = coordinator.requestContainerPackageApproval(
    {
      operation: "install",
      packages: ["jq"],
      expectedRevision: 0,
      sessionId: "session-live",
      runId: "run-live",
    },
    response,
  );
  await until(() => (coordinator as any).approvalWaiters.size === 1);
  const pending = coordinator.approvals.snapshot()[0]!;
  assert.equal(pending.status, "pending");
  assert.equal(builds.length, 0);
  assert.equal(coordinator.queue.snapshot().length, 0);
  await assert.rejects(
    coordinator.decideApproval(pending.id, "approved", "forged-terminal"),
    /attached human terminal/,
  );
  assert.equal(builds.length, 0);
  (coordinator as any).attachments.add("human-a");
  const decided = await coordinator.decideApproval(
    pending.id,
    "approved",
    "human-a",
  );
  assert.equal(decided.status, "succeeded");
  assert.equal((await waiting).status, "succeeded");
  assert.equal(coordinator.queue.snapshot().length, 0);
  assert.equal(
    coordinator.modelSelection.get()?.piImage,
    "sha256:approved-image",
  );
  assert.equal(builds.length, 1);
});

test("[GATEWAY-846B1000] denial is durable and never executes the package request", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  let builds = 0;
  const coordinator = new Coordinator(paths, config, {
      ensureImage: () => {
        builds += 1;
        return "sha256:unexpected";
      },
    }),
    response = waitingResponse();
  await coordinator.modelSelection.set({
    connection: "work",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "1.2.3",
    piImage: "sha256:base",
  });
  const waiting = coordinator.requestContainerPackageApproval(
    {
      operation: "upgrade",
      packages: ["git"],
      expectedRevision: 0,
      sessionId: "session-denied",
    },
    response,
  );
  await until(() => (coordinator as any).approvalWaiters.size === 1);
  const approvalId = coordinator.approvals.snapshot()[0]!.id;
  (coordinator as any).attachments.add("human-denier");
  assert.equal(
    (await coordinator.decideApproval(approvalId, "denied", "human-denier"))
      .status,
    "denied",
  );
  assert.equal((await waiting).status, "denied");
  assert.equal(builds, 0);
});

test("[GATEWAY-846B1000] an orphaned approval survives restart and queues one lineage-aware continuation", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    selection = {
      connection: "work",
      provider: "openai-codex",
      model: "gpt-5.5",
      piVersion: "1.2.3",
      piImage: "sha256:base",
    },
    first = new Coordinator(paths, config),
    response = waitingResponse();
  await first.modelSelection.set(selection);
  const disconnected = first
    .requestContainerPackageApproval(
      {
        operation: "install",
        packages: ["jq"],
        expectedRevision: 0,
        sessionId: "session-ended",
        runId: "run-ended",
      },
      response,
    )
    .catch((error: unknown) => error);
  await until(() => (first as any).approvalWaiters.size === 1);
  const approvalId = first.approvals.snapshot()[0]!.id;
  response.emit("close");
  assert.match(String(await disconnected), /approval remains pending/);

  const restored = new Coordinator(paths, config, {
    ensureImage: () => "sha256:replacement-image",
  });
  await restored.modelSelection.load();
  await restored.queue.load();
  await restored.approvals.load();
  assert.equal(restored.approvals.get(approvalId).status, "pending");
  (restored as any).attachments.add("human-after-restart");
  assert.equal(
    (
      await restored.decideApproval(
        approvalId,
        "approved",
        "human-after-restart",
      )
    ).status,
    "succeeded",
  );
  const continuation = restored.queue.snapshot()[0]!;
  assert.equal(continuation.approvalContinuation?.approvalId, approvalId);
  assert.equal(
    continuation.approvalContinuation?.originSessionId,
    "session-ended",
  );
  assert.equal(continuation.approvalContinuation?.originRunId, "run-ended");
  assert.match(continuation.text, /resolved as succeeded/);
  await assert.rejects(
    restored.decideApproval(approvalId, "denied", "human-after-restart"),
    /already succeeded/,
  );
});

test("[QUEUE-31A6D84F] [CHAT-D7E2F609] one in-flight claim completes to one persisted assistant event before next work", async (t) => {
  const { coordinator } = await coordinatorFixture(t);
  const first = await coordinator.queue.enqueue("one"),
    second = await coordinator.queue.enqueue("two");
  await coordinator.conversation.append({
    type: "user",
    messageId: first.id,
    text: first.text,
  });
  assert.equal((await coordinator.queue.claim())?.id, first.id);
  assert.equal(await coordinator.queue.claim(), undefined);
  await coordinator.conversation.append({
    type: "assistant",
    messageId: first.id,
    text: "answer",
  });
  await coordinator.queue.complete(first.id);
  assert.equal((await coordinator.queue.claim())?.id, second.id);
  assert.deepEqual(
    coordinator.conversation.snapshot().map((e) => e.text),
    ["one", "answer"],
  );
});

test("[CHAT-1C4A8B7E] [QUEUE-8E42F5B1] attached-terminal count can fall to zero without touching queue or conversation state", async (t) => {
  const { coordinator } = await coordinatorFixture(t);
  await coordinator.queue.enqueue("after detach");
  (coordinator as any).attached = 0;
  assert.equal(coordinator.queue.snapshot()[0]?.text, "after detach");
  assert.equal((coordinator as any).snapshot().attached, 0);
});

test("[SERVER-8A31D6C4] coordinator lifecycle can run against controlled listener and interval boundaries", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    calls: string[] = [],
    timer = {};
  let deferred!: () => void;
  const coordinator = new Coordinator(paths, config, {
    servers: {
      async listen(_server, port, address) {
        calls.push(`listen:${address}:${port}`);
      },
      async close() {
        calls.push("close");
      },
    },
    intervals: {
      setInterval(_callback, milliseconds) {
        calls.push(`interval:${milliseconds}`);
        return timer;
      },
      clearInterval(handle) {
        assert.equal(handle, timer);
        calls.push("clear");
      },
    },
    defer(callback) {
      calls.push("defer");
      deferred = callback;
      return callback;
    },
    cancelDeferred() {},
    async listModelChoices() {
      calls.push("catalog");
      return { choices: [] };
    },
  });
  await coordinator.start();
  deferred();
  await (coordinator as any).modelCatalog();
  await coordinator.stop();
  assert.deepEqual(calls, [
    `listen:127.0.0.1:${config.server.coordinatorPort}`,
    "interval:500",
    "defer",
    "catalog",
    "clear",
    "close",
  ]);
});

test("[SERVER-EC7ACFFC] [LOG-28BE37DE] coordinator becomes ready while catalog discovery reports progress in the background", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    calls: string[] = [],
    lines: string[] = [];
  let complete!: (catalog: { choices: []; piVersion: string }) => void,
    catalogStarted!: () => void,
    deferred!: () => void;
  const pending = new Promise<{ choices: []; piVersion: string }>((resolve) => {
      complete = resolve;
    }),
    started = new Promise<void>((resolve) => {
      catalogStarted = resolve;
    }),
    coordinator = new Coordinator(
      paths,
      config,
      {
        servers: {
          async listen() {
            calls.push("listen");
          },
          async close() {},
        },
        intervals: {
          setInterval() {
            return {};
          },
          clearInterval() {},
        },
        defer(callback) {
          deferred = callback;
          return callback;
        },
        cancelDeferred() {},
        async listModelChoices(_paths, _config, progress) {
          calls.push("catalog:start");
          catalogStarted();
          progress?.("runtime.resolve", "checking the Pi runtime");
          return pending;
        },
      },
      new Logger({
        component: "coordinator",
        deploymentId: "test",
        level: "info",
        format: "json",
        sink: (line) => lines.push(line),
      }),
    );

  await coordinator.start();
  deferred();
  await started;
  assert.deepEqual(calls, ["listen", "catalog:start"]);
  assert.ok(
    lines.some(
      (line) =>
        JSON.parse(line).event === "model_catalog.progress" &&
        JSON.parse(line).stage === "runtime.resolve",
    ),
  );

  complete({ choices: [], piVersion: "1.2.3" });
  await (coordinator as any).modelCatalog();
  assert.ok(
    lines.some((line) => JSON.parse(line).event === "model_catalog.ready"),
  );
  await coordinator.stop();
});

test("[LOG-28BE37DE] coordinator warns when background catalog refresh fails", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    lines: string[] = [];
  let deferred!: () => void;
  const coordinator = new Coordinator(
    paths,
    config,
    {
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
      defer(callback) {
        deferred = callback;
        return callback;
      },
      cancelDeferred() {},
      async listModelChoices() {
        throw new Error("registry lookup timed out");
      },
    },
    new Logger({
      component: "coordinator",
      deploymentId: "test",
      level: "info",
      format: "json",
      sink: (line) => lines.push(line),
    }),
  );

  await coordinator.start();
  deferred();
  const refresh = (coordinator as any).modelCatalog() as Promise<unknown>;
  await assert.rejects(refresh, /timed out/);

  const failed = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === "model_catalog.failed");
  assert.equal(failed?.level, "warn");
  assert.equal(failed?.message, "registry lookup timed out");
  await coordinator.stop();
});
