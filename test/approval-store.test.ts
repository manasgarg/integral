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

/* @covers GATEWAY-846B1000
Given the gateway classifies a control operation as requiring human approval
	And container package installation and upgrade are approval-required
	And writes to repositories with host-managed `approval-required` policy are approval-required
	And fresh image rebuilds requested by Pi, host automation, or a remote API are approval-required
	And read-only package inventory is not approval-required
	And read-only repository operations are not approval-required
	When an authenticated Pi session submits an approval-required request
		Then Integral validates it without executing it
			And durably records an unpredictable approval ID, safe summary, canonical request digest, originating actor, session and run, model selection, current revision, and deadline
			And broadcasts the pending approval to every attached human terminal
			And includes it in snapshots for terminals that attach later
			And keeps the originating tool call pending while its connection remains active
			And does not build an image, advance a protected repository ref, or modify package state before approval
Given authenticated host automation or a remote API submits an approval-required request outside Pi
	When Integral creates the approval request
		Then it records the external actor and request origin without inventing a Pi session or run
			And applies the same validation, decision, execution, audit, expiry, and restart lifecycle
Given a trusted local operator invokes `integral image edit` or `integral image rebuild`
	When Integral authorizes the operation
		Then it treats local CLI authority as the human decision
			And bypasses approval-request creation without bypassing validation, build isolation, durable audit, or immutable image selection
Given an approval request is pending
	When an attached human runs `/approve <approval-id>`
		Then Integral binds the decision to that terminal attachment
			And revalidates the exact request and expected revision
			And executes it exactly once using the approval ID as its idempotency key
			And durably records and broadcasts the result or failure
	When an attached human runs `/deny <approval-id>`
		Then Integral binds the decision to that terminal attachment
			And durably records and broadcasts the denial
			And does not execute the request
	When another human attempts to decide the resolved approval
		Then Integral rejects the later decision
			And does not execute the request again
	When the request revision is stale at approval time
		Then Integral records and broadcasts a stale outcome
			And does not execute the request
	When the request is a fresh rebuild with floating dependencies
		Then Integral shows the active recipe commit, prior image digest, mutable inputs, and build-time resolution warning
			And approval authorizes resolution against the configured repositories at execution time rather than an exact dependency closure
Given an approval is resolved while its originating Pi tool call remains connected
	When Integral completes the decision
		Then it returns the durable outcome to that tool call
			And does not create a replacement session solely for the outcome
Given an approval remains unresolved after its originating Pi session ends
	When the session ends
		Then Integral keeps the approval open
			And revokes the ended session's temporary credentials
			And retains the exact request, originating session and run, and model selection
	When a human later approves, denies, or lets the request expire
		Then Integral durably queues an approval-resolution continuation
			And starts a new Pi session using the resulting current image and model
			And gives it the approval ID, safe action summary, and outcome
			And restores the preceding conversation context
			And records the ended session and run as its parent lineage
Given Integral restarts with unresolved approvals
	When the coordinator recovers durable state
		Then it preserves every unresolved approval in its prior state
			And does not cancel, deny, approve, or execute it merely because Integral restarted
			And republishes it to attached human terminals
	When it recovers a durably approved operation without a durable execution result
		Then it resumes execution using the approval ID
			And prevents duplicate package-state or protected-repository changes
Given an unresolved approval reaches its ten-minute deadline
	When Integral expires it
		Then Integral records and broadcasts an expired outcome without executing the request
			And never approves it automatically
			And delivers the outcome through the live tool call or a replacement-session continuation
When an approval changes state
	Then Integral writes a durable audit record with its safe summary, request digest, lineage, decision identity, execution state, and timestamps
		And never records credentials or secret request values
*/
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

/* @covers BOX-6A91C3E7
Given Integral owns a dedicated governed Git repository for the deployment's Pi image overlay
	And Integral's foundational Pi image, runtime user, gateway trust, entrypoint, and security constraints are outside that repository
	And the image repository has an immutable host-managed `approval-required` write policy
	When Integral provisions a Pi session
		Then it gives Pi a writable per-run checkout of the active image-recipe commit at a documented container path
			And includes a Dockerfile based on the exact host-managed foundational image reference
			And tells Pi that it runs in an ephemeral managed container
			And tells Pi that edits affect only a future replacement image after human approval
			And does not mount the canonical host repository, Docker socket, build credentials, or host Dockerfile into the container
	When Pi commits an image-recipe change and submits it through `repo_push`
		Then Integral treats the commit as an image proposal governed by `REPO-7B0E2F4A`
			And presents the exact Dockerfile and artifact diff, base commit, proposed commit, and tree digest for approval
			And keeps the active recipe ref and selected image unchanged before approval
	When the active Dockerfile declares an exact package version or immutable image digest
		Then Integral uses that exact declaration on every build
	When the active Dockerfile declares a floating package version, mutable image tag, or unversioned operating-system package
		Then Integral treats resolution at build time as intentional recipe behavior
			And does not describe the recipe commit as a reproducible package lock
			And tells an approving human that repository state may resolve differently at execution time
	When Pi requests a fresh rebuild of the active image recipe
		Then Integral creates an approval request bound to the active recipe commit, foundational image reference, and floating-resolution intent
			And does not build or select an image before approval
	When a trusted local operator runs `integral image edit`
		Then Integral validates and commits the Dockerfile change directly through the host boundary
			And records the operator and exact Git change without creating an approval request
	When a trusted local operator runs `integral image rebuild`
		Then Integral treats the command itself as direct human authorization to rebuild the active recipe
			And records the operator without creating an approval request or inventing a Pi session
	When host automation or a remote API requests a fresh rebuild without starting Pi
		Then Integral creates the same governed rebuild request used for Pi
			And records the external actor instead of inventing a Pi session
			And requires human approval before building
	When a human approves the exact image proposal
		Then Integral builds only the approved commit and complete tree digest
			And uses a build context containing only validated files from that tree
			And provides no host source tree, session credentials, Docker socket, or undeclared secret to the build
			And applies bounded build time, CPU, memory, output size, and network policy
			And records the foundational image reference, recipe base and proposal commits, tree digest, approval ID, and resulting immutable image digest
	When Integral executes a fresh rebuild authorized by approval or the trusted local CLI
		Then Integral pulls mutable base references again
			And reruns dependency installation without Docker layer-cache reuse
			And refreshes package indexes within the build as directed by the Dockerfile
			And resolves `latest`, ranges, mutable tags, and unversioned packages against their configured repositories at build time
			And never substitutes an older selected package version for a floating Dockerfile declaration
			And records the recipe commit, prior image digest, resulting image digest, and actual installed package inventory
			And permits the resulting image digest and installed inventory to differ from an earlier build of the same recipe commit
	When the approved image build and validation succeed
		Then Integral compare-and-swap advances the active recipe ref from the approved base to the approved commit
			And selects the resulting immutable image for replacement sessions
			And starts or recycles Pi according to the approval continuation lifecycle
	When the build or image validation fails
		Then Integral records and broadcasts a failed approval outcome
			And leaves the active recipe ref and selected image unchanged
			And keeps the proposal commit available according to bounded audit and recovery policy
	When Pi proposes a recipe that changes the foundational image boundary or requires an undeclared build input
		Then Integral rejects it without requesting approval or starting a build
	When a later Pi session starts from an activated recipe
		Then its projected image-recipe checkout identifies the exact active commit and host-managed foundational image reference
			And Pi can propose a rollback or further change through the same approval-gated path
*/
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
