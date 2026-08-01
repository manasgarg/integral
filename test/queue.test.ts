import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import {
  createSnowflakeId,
  DurableQueue,
  ConversationStore,
  SNOWFLAKE_EPOCH,
} from "../src/queue.ts";
import { fixture } from "./helpers.ts";

test("[QUEUE-5B7C2E91] [QUEUE-6A1B4E82] concurrent submissions commit one durable opaque-ID order", async (t) => {
  const paths = await fixture(t),
    events: unknown[] = [],
    queue = new DurableQueue(paths.queue, (e) => events.push(e));
  await queue.load();
  const items = await Promise.all([
    queue.enqueue("one"),
    queue.enqueue("two"),
    queue.enqueue("three"),
  ]);
  assert.deepEqual(
    queue.snapshot().map((m) => m.text),
    ["one", "two", "three"],
  );
  assert.deepEqual(
    items.map((m) => m.order),
    [1, 2, 3],
  );
  assert.equal(new Set(items.map((m) => m.id)).size, 3);
  for (const item of items) assert.match(item.id, /^[0-9A-Z]{1,13}$/);
  assert.equal(events.length, 3);
});

test("[QUEUE-5B7C2E91] Snowflakes encode time, worker, and sequence as uppercase base 36", () => {
  const first = createSnowflakeId(SNOWFLAKE_EPOCH + 1, 1),
    second = createSnowflakeId(SNOWFLAKE_EPOCH + 1, 1, first.state),
    rollback = createSnowflakeId(SNOWFLAKE_EPOCH, 1, second.state);
  assert.equal(first.id, "2HZI8");
  assert.equal(second.id, "2HZI9");
  assert.equal(rollback.state.timestamp, SNOWFLAKE_EPOCH + 1);
  assert.equal(rollback.state.sequence, 2);
  assert.match(rollback.id, /^[0-9A-Z]+$/);
});

test("[QUEUE-5B7C2E91] persisted Snowflake state prevents reuse after restart and clock rollback", async (t) => {
  const paths = await fixture(t),
    before = new DurableQueue(
      paths.queue,
      () => undefined,
      () => SNOWFLAKE_EPOCH + 10,
    ),
    first = await before.enqueue("first"),
    after = new DurableQueue(
      paths.queue,
      () => undefined,
      () => SNOWFLAKE_EPOCH + 5,
    );
  await after.load();
  const second = await after.enqueue("second");
  assert.notEqual(second.id, first.id);
  assert.ok(second.id > first.id);
});

test("[QUEUE-31A6D84F] only one oldest message is in flight and completion exposes the next", async (t) => {
  const paths = await fixture(t),
    queue = new DurableQueue(paths.queue);
  await queue.enqueue("first");
  await queue.enqueue("second");
  const first = await queue.claim();
  assert.equal(first?.text, "first");
  assert.equal(await queue.claim(), undefined);
  await queue.complete(first.id);
  assert.equal((await queue.claim())?.text, "second");
});

test("[QUEUE-A19D6F43] queue snapshots show stable IDs, text, delivery order, and in-flight state", async (t) => {
  const paths = await fixture(t),
    queue = new DurableQueue(paths.queue);
  const a = await queue.enqueue("a"),
    b = await queue.enqueue("b");
  await queue.claim();
  assert.deepEqual(
    queue.snapshot().map(({ id, text, status }) => ({ id, text, status })),
    [
      { id: a.id, text: "a", status: "in-flight" },
      { id: b.id, text: "b", status: "queued" },
    ],
  );
});

test("[QUEUE-C84E1A70] editing preserves message identity and position and persists before notification", async (t) => {
  const paths = await fixture(t),
    events: unknown[] = [],
    queue = new DurableQueue(paths.queue, (e) => events.push(e));
  const a = await queue.enqueue("old"),
    b = await queue.enqueue("later");
  const edited = await queue.edit(a.id, "new");
  assert.equal(edited.id, a.id);
  assert.deepEqual(
    queue.snapshot().map((m) => [m.id, m.text]),
    [
      [a.id, "new"],
      [b.id, "later"],
    ],
  );
  const restored = new DurableQueue(paths.queue);
  await restored.load();
  assert.equal(restored.snapshot()[0]?.text, "new");
  assert.equal((events.at(-1) as { type: string }).type, "edited");
});

test("[QUEUE-2F6B9D04] deletion persists and deleted messages are never claimable", async (t) => {
  const paths = await fixture(t),
    queue = new DurableQueue(paths.queue);
  const deleted = await queue.enqueue("remove"),
    kept = await queue.enqueue("keep");
  await queue.delete(deleted.id);
  assert.equal((await queue.claim())?.id, kept.id);
  const restored = new DurableQueue(paths.queue);
  await restored.load();
  assert.equal(
    restored.snapshot().some((m) => m.id === deleted.id),
    false,
  );
});

test("[QUEUE-D31A7C68] claimed messages reject edits and deletion without changing the turn", async (t) => {
  const paths = await fixture(t),
    queue = new DurableQueue(paths.queue);
  const item = await queue.enqueue("original");
  await queue.claim();
  await assert.rejects(queue.edit(item.id, "changed"), /in flight/);
  await assert.rejects(queue.delete(item.id), /in flight/);
  assert.equal(queue.snapshot()[0]?.text, "original");
});

test("[QUEUE-8E42F5B1] queue ownership is independent of terminal attachment", async (t) => {
  const paths = await fixture(t),
    queue = new DurableQueue(paths.queue);
  await queue.enqueue("durable");
  assert.equal(queue.snapshot().length, 1);
});

test("[QUEUE-F0C937AD] restart recovery retains acknowledged edits, deletions, and order and requeues in-flight work", async (t) => {
  const paths = await fixture(t),
    before = new DurableQueue(paths.queue);
  const a = await before.enqueue("a"),
    b = await before.enqueue("b"),
    c = await before.enqueue("c");
  await before.delete(b.id);
  await before.edit(c.id, "edited");
  await before.claim();
  const after = new DurableQueue(paths.queue);
  await after.load();
  assert.deepEqual(
    after.snapshot().map((m) => [m.id, m.text, m.status]),
    [
      [a.id, "a", "queued"],
      [c.id, "edited", "queued"],
    ],
  );
});

test("[QUEUE-F0C937AD] restart recovery preserves legacy UUID and ULID IDs", async (t) => {
  const paths = await fixture(t),
    legacyId = "f4e77892-e27d-4df5-8274-1ea268238363",
    ulid = "01K3Y8N9R7M2X4V6Q8ZACBDEFG";
  await mkdir(paths.data, { recursive: true });
  await writeFile(
    paths.queue,
    `${JSON.stringify({
      nextOrder: 3,
      items: [
        {
          id: legacyId,
          text: "legacy",
          order: 1,
          status: "in-flight",
          attempts: 3,
          createdAt: "2026-08-01T22:42:12.900Z",
        },
        {
          id: ulid,
          text: "ulid",
          order: 2,
          status: "queued",
          attempts: 0,
          createdAt: "2026-08-02T12:00:00.000Z",
        },
      ],
    })}\n`,
  );
  const queue = new DurableQueue(paths.queue);
  await queue.load();
  assert.deepEqual(
    queue.snapshot().map(({ id, status }) => ({ id, status })),
    [
      { id: legacyId, status: "queued" },
      { id: ulid, status: "queued" },
    ],
  );
});

test("[QUEUE-947D3AC0] unknown and deleted IDs are refused without changing state", async (t) => {
  const paths = await fixture(t),
    queue = new DurableQueue(paths.queue);
  const item = await queue.enqueue("x");
  await queue.delete(item.id);
  await assert.rejects(queue.edit(item.id, "y"), /not queued/);
  await assert.rejects(queue.delete("unknown"), /not queued/);
  assert.deepEqual(queue.snapshot(), []);
});

test("[QUEUE-3C8E71B4] mutations are not acknowledged or broadcast when persistence fails", async (t) => {
  const paths = await fixture(t),
    events: unknown[] = [],
    blocker = join(paths.root, "blocked"),
    queue = new DurableQueue(join(blocker, "queue.json"), (e) =>
      events.push(e),
    );
  await writeFile(blocker, "not a directory");
  await assert.rejects(queue.enqueue("no commit"));
  assert.deepEqual(queue.snapshot(), []);
  assert.deepEqual(events, []);
});

test("[CHAT-B46C81F5] [CONFIG-F2C84D16] restored context selects newest persisted messages within both configured limits", async (t) => {
  const paths = await fixture(t),
    conversation = new ConversationStore(paths.conversation);
  await conversation.append({ type: "user", text: "111" });
  await conversation.append({ type: "assistant", text: "2222" });
  await conversation.append({ type: "user", text: "33" });
  assert.deepEqual(
    conversation.context(2, 6).map((e) => e.text),
    ["2222", "33"],
  );
  assert.deepEqual(conversation.context(0, 100), []);
});

test("[CHAT-4F29A6D8] durable conversation events restore in committed order", async (t) => {
  const paths = await fixture(t),
    before = new ConversationStore(paths.conversation);
  await before.append({ type: "user", text: "hello" });
  await before.append({ type: "assistant", text: "hi" });
  const after = new ConversationStore(paths.conversation);
  await after.load();
  assert.deepEqual(
    after.snapshot().map((e) => [e.sequence, e.type, e.text]),
    [
      [1, "user", "hello"],
      [2, "assistant", "hi"],
    ],
  );
});

test("[QUEUE-C84E1A70] [QUEUE-2F6B9D04] queued edits and deletions can keep the durable user conversation aligned", async (t) => {
  const paths = await fixture(t),
    conversation = new ConversationStore(paths.conversation);
  const a = await conversation.append({
    type: "user",
    messageId: "a",
    text: "old",
  });
  await conversation.append({ type: "user", messageId: "b", text: "delete" });
  await conversation.editUser(a.messageId!, "new");
  await conversation.deleteUser("b");
  const restored = new ConversationStore(paths.conversation);
  await restored.load();
  assert.deepEqual(
    restored.snapshot().map((e) => [e.messageId, e.text]),
    [["a", "new"]],
  );
});
