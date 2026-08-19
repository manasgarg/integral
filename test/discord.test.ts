import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { validateConnection, connectionToml } from "../src/connections.ts";
import {
  DiscordIngressStore,
  discordChunks,
  verifyDiscordBot,
} from "../src/discord.ts";
import { DurableQueue } from "../src/queue.ts";
import { DurableTaskQueue } from "../src/task-queue.ts";
import { fixture } from "./helpers.ts";

test("Discord connection binds immutable application, bot, user, and DM IDs", () => {
  const connection = validateConnection({
    name: "discord",
    kind: "channel",
    provider: "discord",
    auth: "key",
    application_id: "100000000000000001",
    bot_user_id: "100000000000000002",
    user_id: "100000000000000003",
    channel_id: "100000000000000004",
  });
  assert.equal(connection.kind, "channel");
  assert.equal(connection.channelId, "100000000000000004");
  assert.match(connectionToml(connection), /user_id = "100000000000000003"/);
  assert.throws(
    () =>
      validateConnection({
        name: "discord",
        kind: "channel",
        provider: "discord",
        auth: "key",
        application_id: "not-an-id",
        bot_user_id: "100000000000000002",
        user_id: "100000000000000003",
        channel_id: "100000000000000004",
      }),
    /Discord snowflake/,
  );
});

test("Discord bot verification resolves host-controlled identities and DM", async () => {
  const requests: Array<{
    url: string;
    authorization: string | null;
    body?: string;
  }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      headers = new Headers(init?.headers);
    requests.push({
      url,
      authorization: headers.get("authorization"),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const id = url.endsWith("/users/@me")
      ? "100000000000000002"
      : url.endsWith("/oauth2/applications/@me")
        ? "100000000000000001"
        : "100000000000000004";
    return Response.json({ id });
  };
  const verified = await verifyDiscordBot(
    "protected-token",
    "100000000000000003",
    fetcher,
  );
  assert.deepEqual(verified, {
    applicationId: "100000000000000001",
    botUserId: "100000000000000002",
    userId: "100000000000000003",
    channelId: "100000000000000004",
  });
  assert.ok(
    requests.every(
      (request) => request.authorization === "Bot protected-token",
    ),
  );
  assert.equal(requests.at(-1)?.body, '{"recipient_id":"100000000000000003"}');
});

test("Discord ingress checkpoints and queue origins survive restart without duplicates", async (t) => {
  const paths = await fixture(t),
    stateFile = join(
      paths.channels,
      "discord-100000000000000004",
      "ingress.json",
    ),
    queueFile = join(
      paths.channels,
      "discord-100000000000000004",
      "queue.json",
    ),
    ingress = new DiscordIngressStore(stateFile),
    queue = new DurableQueue(queueFile),
    origin = {
      provider: "discord" as const,
      externalId: "110000000000000001",
      userId: "100000000000000003",
      channelId: "100000000000000004",
    };
  await ingress.load();
  await queue.load();
  const first = await queue.enqueue("hello", undefined, origin),
    duplicate = await queue.enqueue("hello", undefined, origin);
  await ingress.record(origin.externalId);
  assert.equal(first.id, duplicate.id);
  assert.equal(queue.snapshot().length, 1);

  const restoredIngress = new DiscordIngressStore(stateFile),
    restoredQueue = new DurableQueue(queueFile);
  await restoredIngress.load();
  await restoredQueue.load();
  assert.equal(restoredIngress.position(), origin.externalId);
  assert.equal(
    restoredQueue.snapshot()[0]?.origin?.channelId,
    origin.channelId,
  );
});

test("Discord steering state becomes queued after restart if delivery did not finish", async (t) => {
  const paths = await fixture(t),
    queue = new DurableQueue(paths.queue),
    first = await queue.enqueue("first"),
    later = await queue.enqueue("change direction");
  await queue.claim();
  await queue.markSteering(later.id);
  assert.deepEqual(
    queue.snapshot().map(({ id, status }) => ({ id, status })),
    [
      { id: first.id, status: "in-flight" },
      { id: later.id, status: "steering" },
    ],
  );
  const restored = new DurableQueue(paths.queue);
  await restored.load();
  assert.deepEqual(
    restored.snapshot().map((message) => message.status),
    ["queued", "queued"],
  );
});

test("Discord reply chunks preserve order, Unicode pairs, and the message limit", () => {
  const text = `${"a".repeat(1_999)}😀\n${"b".repeat(2_100)}`,
    chunks = discordChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 2_000));
  assert.ok(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/.test(chunk)));
  assert.equal(chunks.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("Discord task origin survives acceptance and completion outbox persistence", async (t) => {
  const paths = await fixture(t),
    tasks = new DurableTaskQueue(paths),
    origin = {
      provider: "discord" as const,
      conversationId: "discord:100000000000000004",
      externalId: "110000000000000001",
      userId: "100000000000000003",
      channelId: "100000000000000004",
    };
  await tasks.load();
  const task = await tasks.accept({
    executionId: "execution-1",
    scheduleId: "schedule-1",
    scheduleRevision: 1,
    triggerType: "once",
    scheduledFor: new Date().toISOString(),
    prompt: "prepare report",
    profile: {
      connection: "model",
      provider: "anthropic",
      model: "claude",
      piVersion: "1",
      piImage: "image",
    },
    state: "pending",
    dispatchAttempts: 0,
    createdAt: new Date().toISOString(),
    origin,
  });
  assert.deepEqual(task.origin, origin);
  await tasks.cancel(task.executionId);
  assert.deepEqual(tasks.outbox()[0]?.origin, origin);
  assert.equal(tasks.outbox()[0]?.taskId, task.id);
});
