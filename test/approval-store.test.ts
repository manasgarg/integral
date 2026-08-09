import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ApprovalStore } from "../src/approval-store.ts";
import { fixture } from "./helpers.ts";

const selection = {
  connection: "work",
  provider: "openai-codex",
  model: "gpt-5.5",
  piVersion: "1.2.3",
  piImage: "sha256:pi",
};

test("[GATEWAY-846B1000] unresolved approvals and their safe audit trail survive restart", async (t) => {
  const paths = await fixture(t);
  let now = Date.parse("2026-08-09T10:00:00.000Z");
  const first = new ApprovalStore(
      paths,
      () => now,
      () => "approval-1",
    ),
    created = await first.create({
      request: {
        kind: "container-packages",
        operation: "install",
        packages: ["jq"],
        expectedRevision: 0,
      },
      sessionId: "session-1",
      runId: "run-1",
      selection,
    });
  assert.equal(created.status, "pending");
  assert.equal(created.expiresAt, "2026-08-09T10:10:00.000Z");
  const restored = new ApprovalStore(paths, () => now);
  await restored.load();
  assert.deepEqual(restored.get(created.id), created);
  const audit = await readFile(paths.approvalAudit, "utf8");
  assert.match(audit, /approval-1/);
  assert.match(audit, /install Debian packages: jq/);
  assert.doesNotMatch(audit, /credential|Bearer|secret-value/);

  now += 600_001;
  const expired = await restored.expireDue();
  assert.equal(expired[0]?.status, "expired");
  assert.equal((await restored.expireDue()).length, 0);
});

test("[GATEWAY-846B1000] the first human decision wins and approved execution is durable", async (t) => {
  const paths = await fixture(t),
    store = new ApprovalStore(paths, Date.now, () => "approval-2"),
    created = await store.create({
      request: {
        kind: "container-packages",
        operation: "upgrade",
        packages: ["git"],
        expectedRevision: 0,
      },
      sessionId: "session-2",
      selection,
    });
  assert.equal(
    (await store.decide(created.id, "approved", "attachment-a")).status,
    "approved",
  );
  await assert.rejects(
    store.decide(created.id, "denied", "attachment-b"),
    /already approved/,
  );
  const completed = await store.resolveExecution(created.id, {
    status: "succeeded",
    result: { revision: 1, piImage: "sha256:updated" },
  });
  assert.equal(completed.status, "succeeded");
  const restored = new ApprovalStore(paths);
  await restored.load();
  assert.equal(restored.get(created.id).execution?.result?.revision, 1);
});

test("[BOX-6A91C3E7] image recipe approvals retain the exact public diff and private proposal ref across restart", async (t) => {
  const paths = await fixture(t),
    store = new ApprovalStore(paths, Date.now, () => "approval-image"),
    created = await store.create({
      request: {
        kind: "image-recipe",
        operation: "proposal",
        baseCommit: "a".repeat(40),
        proposedCommit: "b".repeat(40),
        proposalRef: "refs/integral/proposals/private-ref",
        treeDigest: "c".repeat(40),
        changedPaths: ["Dockerfile"],
        diff: "+RUN npm install package@latest",
        priorImage: "sha256:prior",
      },
      sessionId: "session-image",
      runId: "run-image",
      selection,
    });
  assert.match(String(store.snapshot()[0]?.details?.diff), /package@latest/);
  assert.doesNotMatch(JSON.stringify(store.snapshot()[0]), /private-ref/);
  const restored = new ApprovalStore(paths);
  await restored.load();
  const request = restored.get(created.id).request;
  assert.equal(
    request.kind === "image-recipe" ? request.proposalRef : undefined,
    "refs/integral/proposals/private-ref",
  );
});
