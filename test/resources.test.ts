import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { validateConnection } from "../src/connections.ts";
import { readText } from "../src/fs.ts";
import { Gateway } from "../src/gateway.ts";
import { Logger } from "../src/logging.ts";
import {
  addHostResource,
  cleanupResourceProjection,
  createResource,
  listStoreSnapshots,
  listRepositoryRecovery,
  prepareResourceProjection,
  readResource,
  refreshResource,
  repositoryBundlePush,
  restoreResource,
  restoreStoreSnapshot,
  sessionHasResource,
  softDeleteResource,
  validateMountPath,
} from "../src/resources.ts";
import { deploymentId } from "../src/state.ts";
import { fixture } from "./helpers.ts";

const run = promisify(execFile);

/* @covers REPO-515BAAB9
Given Pi or the connection CLI creates, adds, or restores a governed repository or store
	When integral validates the requested mount path
		Then it requires an absolute normalized path below `/home/pi`
			And rejects `/home/pi` itself
			And rejects `.pi`, `history`, Integral control paths, and their descendants
			And rejects traversal, a symlink escape, or a target outside the current session home
			And rejects a path equal to, above, or below another governed resource mount
			And rejects a target containing files not owned by that resource
			And records the normalized container path rather than a host path
*/
test("[REPO-515BAAB9] governed mount paths stay below the safe Pi home namespace", () => {
  assert.equal(validateMountPath("/home/pi/work/repo"), "/home/pi/work/repo");
  for (const path of [
    "relative",
    "/home/pi",
    "/home/pi/.pi",
    "/home/pi/.pi/extensions",
    "/home/pi/history/runs",
    "/tmp/repo",
  ])
    assert.throws(() => validateMountPath(path));
});

/* @covers CONNECTION-C0978F5E
Given the connection CLI is adding an existing host repository or store
	When integral validates its source path
		Then it resolves symbolic links and records one canonical absolute host path
			And rejects the filesystem root
			And rejects an Integral deployment root, control-plane directory, credential directory, or any of their ancestors
			And rejects a path equal to, above, or below another configured host resource
			And rejects a socket, device, named pipe, or other source of the wrong filesystem type
			And performs all validation in trusted host code
			And never makes the source path available to Pi
*/
test("[CONNECTION-C0978F5E] host-resource validation canonicalizes safe directories and rejects trusted-path boundary violations", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    outside = `${paths.root}-source-validation`,
    canonical = join(outside, "canonical"),
    alias = join(outside, "alias"),
    nested = join(canonical, "nested"),
    file = join(outside, "file");
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(nested, { recursive: true });
  await symlink(canonical, alias);
  await writeFile(file, "not a directory");

  const accepted = await addHostResource(
    paths,
    validateConnection({
      name: "canonical",
      kind: "host-store",
      auth: "none",
      path: alias,
      mount: "/home/pi/canonical",
    }),
    config,
  );
  assert.equal(accepted.path, canonical);

  for (const [name, source, message] of [
    ["root", "/", /filesystem root/],
    ["deployment", paths.root, /deployment root/],
    ["overlap", nested, /overlaps connection canonical/],
    ["wrong-type", file, /must be a directory/],
  ] as const) {
    await assert.rejects(
      addHostResource(
        paths,
        validateConnection({
          name,
          kind: "host-store",
          auth: "none",
          path: source,
          mount: `/home/pi/${name}`,
        }),
        config,
      ),
      message,
    );
  }
});

/* @covers CONNECTION-717CAD0E
Given a host-repository or host-store connection records a canonical path and backing filesystem identity
	When the periodic health check, session provisioner, or a host-mediated resource operation validates it
		Then integral distinguishes `missing`, `wrong_type`, `permission_denied`, `identity_changed`, `invalid_repository`, and `read_only` where applicable
			And marks an active failing resource unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation exactly once when it transitions from active
			And does not terminate or replace an existing Pi session
			And never recreates missing backing data
	When an unavailable resource reappears with the same filesystem identity and passes validation
		Then integral returns it to active for sessions started afterward
			And advances its lifecycle revision and the connection generation
			And does not alter any existing session
	When a different backing identity appears at the recorded path
		Then integral leaves the resource unavailable
			And never silently adopts the replacement
			And requires the operator to soft-delete the unavailable resource and add the replacement as a new governed resource
	When the operator tries to add a replacement path still referenced by an existing session
		Then integral rejects the addition until every session using the prior backing identity ends naturally
*/
test("[CONNECTION-717CAD0E] a replacement directory is never silently adopted, while the recorded identity can recover", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    backing = `${paths.root}-identity-store`,
    original = `${backing}.original`;
  t.after(() => rm(backing, { recursive: true, force: true }));
  t.after(() => rm(original, { recursive: true, force: true }));
  await mkdir(backing);
  const resource = await addHostResource(
    paths,
    validateConnection({
      name: "identity",
      kind: "host-store",
      auth: "none",
      path: backing,
      mount: "/home/pi/identity",
    }),
    config,
  );
  await rename(backing, original);
  await mkdir(backing);
  const replaced = await refreshResource(paths, resource);
  assert.equal(replaced.state, "unavailable");
  assert.equal(replaced.availabilityReason, "identity_changed");
  await rm(backing, { recursive: true });
  await rename(original, backing);
  const recovered = await refreshResource(paths, replaced);
  assert.equal(recovered.state, "active");
  assert.equal(recovered.identity.inode, resource.identity.inode);
});

/* @covers STORE-18E17123
Given one or more host-store connections are active and have mount paths
	When integral provisions an interactive or isolated scheduled Pi session
		Then it bind-mounts each backing directory read-write at its recorded mount path
			And exposes the same durable bytes to every run in that deployment
			And does not copy the store into temporary session storage
			And does not expose another deployment's stores or the backing host path
			And keeps the mount inside the container's non-root and capability-free boundary
	When any active store is missing, not a directory, or not writable by the Integral host process
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And provisions the session with the remaining active resources
			And tells Pi which named store is unavailable without exposing its host path
*/
/* @covers STORE-0A19F4CB
Given a Pi session was provisioned with a governed store mount
	When trusted host code detects that its recorded path is missing, inaccessible, the wrong type, not writable, or replaced by another filesystem identity
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And leaves the existing Pi session and mount running until its ordinary end
			And does not unmount, replace, or otherwise normalize the session's filesystem view
			And lets later reads and writes through that mount succeed or fail according to the host filesystem
			And rejects snapshot or restoration operations that require the unavailable backing path with `resource_unavailable`
	When integral starts a later Pi session
		Then it omits the unavailable store
			And tells Pi the connection name and bounded availability reason without exposing its host path
	When a filesystem operation through the retained mount succeeds after the recorded host path becomes unavailable
		Then integral accepts the filesystem result without intervening
			And does not promise that the bytes remain reachable after the retained mount ends
*/
test("[CONNECTION-717CAD0E] [STORE-18E17123] [STORE-0A19F4CB] host stores retain existing projections but disappear from later sessions after failure", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    backing = `${paths.root}-operator-store`;
  t.after(() => rm(backing, { recursive: true, force: true }));
  t.after(() => rm(`${backing}.missing`, { recursive: true, force: true }));
  await mkdir(backing);
  await writeFile(join(backing, "value.txt"), "durable");
  const resource = await addHostResource(
    paths,
    validateConnection({
      name: "documents",
      kind: "host-store",
      auth: "none",
      path: backing,
      mount: "/home/pi/documents",
    }),
    config,
  );
  const firstHome = join(paths.root, "first-home");
  await mkdir(firstHome);
  const first = await prepareResourceProjection(
    paths,
    config,
    firstHome,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(first.mounts, [
    { source: backing, target: "/home/pi/documents", readonly: false },
  ]);
  assert.equal(
    await sessionHasResource(
      paths,
      resource.id,
      "11111111-1111-4111-8111-111111111111",
    ),
    true,
  );
  assert.equal(await sessionHasResource(paths, resource.id, "unknown"), false);
  await rename(backing, `${backing}.missing`);
  const unavailable = await refreshResource(
    paths,
    (await readResource(paths, "documents"))!,
  );
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.availabilityReason, "missing");
  assert.equal(first.mounts[0]?.source, backing);
  const laterHome = join(paths.root, "later-home");
  await mkdir(laterHome);
  const later = await prepareResourceProjection(
    paths,
    config,
    laterHome,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(later.mounts.length, 0);
  assert.deepEqual(later.unavailable, [
    { name: "documents", kind: "host-store", reason: "missing" },
  ]);
  await rename(`${backing}.missing`, backing);
  assert.equal((await refreshResource(paths, unavailable)).state, "active");
  assert.equal(resource.path, backing);
  await cleanupResourceProjection(paths, config, first);
  assert.equal(
    await sessionHasResource(
      paths,
      resource.id,
      "11111111-1111-4111-8111-111111111111",
    ),
    false,
  );
});

/* @covers REPO-95B5606D
Given an active governed repository is visible to Pi
	Or an unavailable governed repository is visible to Pi
	When Pi calls `repo_delete` with its repository ID and expected lifecycle revision
		Then integral records a tombstone containing the repository identity, canonical branch, prior mount path, and deletion actor
			And removes the repository from the active connection inventory
			And prevents every existing checkout from landing after the deletion revision
			And rejects later `repo_push` and `git fetch origin` calls from those checkouts as `resource_soft_deleted`
			And leaves every existing Pi session and checkout running until its ordinary end
			And lets those checkouts continue local edits and Git commits
			And preserves unlanded work from each checkout when its session ordinarily ends
			And omits the repository from every session started after deletion
			And preserves the canonical repository and its complete history
			And reports that the current session retains its checkout until it ends
	When the expected lifecycle revision is stale
		Then integral rejects deletion without changing the repository or its active checkouts
*/
/* @covers STORE-4C006F7D
Given a governed store was created through Pi or added from an existing host path
	When Pi or the connection CLI performs a lifecycle operation
		Then integral applies the same states, revisions, tools, snapshot policy, and restoration rules
			And does not record or expose an ownership or provenance classification
	When Pi soft-deletes it or the user removes its connection
		Then integral removes access and preserves a tombstone
			And never deletes, moves, rewrites, or changes filesystem ownership of its backing directory merely because access was removed
*/
test("[REPO-95B5606D] [STORE-83D2CD52] [STORE-4C006F7D] soft deletion preserves current leases and backing bytes without replacing the active session", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    resource = await createResource(
      paths,
      "host-store",
      "memory",
      "/home/pi/memory",
      config,
    ),
    home = join(paths.root, "home");
  await mkdir(home);
  await writeFile(join(resource.path, "kept.txt"), "yes");
  const projection = await prepareResourceProjection(
    paths,
    config,
    home,
    "33333333-3333-4333-8333-333333333333",
  );
  const sessionGeneration = await readText(
    join(paths.state, "session-generation"),
  );
  const deleted = await softDeleteResource(
    paths,
    resource.connection,
    resource.revision,
    "pi:test",
  );
  assert.equal(deleted.state, "soft-deleted");
  assert.equal(
    await readText(join(paths.state, "session-generation")),
    sessionGeneration,
  );
  assert.equal(await readFile(join(resource.path, "kept.txt"), "utf8"), "yes");
  assert.equal(projection.mounts.length, 1);
  const laterHome = join(paths.root, "later");
  await mkdir(laterHome);
  assert.equal(
    (await prepareResourceProjection(paths, config, laterHome, "later")).mounts
      .length,
    0,
  );
  const restored = await restoreResource(
    paths,
    resource.connection,
    deleted.revision,
    "/home/pi/restored-memory",
  );
  assert.equal(restored.state, "active");
  assert.notEqual(
    await readText(join(paths.state, "session-generation")),
    sessionGeneration,
  );
  await cleanupResourceProjection(paths, config, projection);
  assert.equal((await listStoreSnapshots(paths, resource.id)).length, 1);
});

/* @covers REPO-403F597E
Given Pi has an authenticated integral session
	When Pi calls `repo_create` with a unique connection name and mount path
		Then integral creates a stable repository ID
			And creates a bare canonical repository under the deployment data directory
			And initializes its canonical branch as `main`
			And records the canonical path and filesystem identity of its backing root
			And records the requested mount path with the repository connection
			And creates a checkout on a branch named for the current run
			And marks the current session for replacement after the tool reports durable creation
			And makes the repository available at that path before the next Pi prompt
			And uses the same path in every later Pi session
			And does not expose the canonical host path to Pi
	When canonical creation or checkout placement fails
		Then the tool reports failure without an active repository connection
			And removes any incomplete canonical repository and checkout created by that operation
*/
/* @covers REPO-A690931F
Given one or more governed repository connections are active and have mount paths
	When integral provisions an interactive or isolated scheduled Pi session
		Then it creates a separate checkout for that run from each canonical branch head
			And places each checkout at its recorded mount path
			And checks out a branch whose identity includes the run ID
			And configures `origin` as a read-only integral transport for the canonical repository
			And permits `git fetch origin`
			And refuses a direct `git push origin`
			And does not mount a canonical repository or its host parent directory into the container
	When any active repository cannot be materialized at its recorded path
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And removes any partial checkout for that repository
			And provisions the session with the remaining active resources
			And tells Pi which named repository is unavailable without exposing its host path
*/
/* @covers REPO-CDA4609A
Given Pi has committed work on a current-run governed repository branch
	And that repository's host-managed write policy is `direct`
	When Pi calls `repo_push` for that repository
		Then the container sends a Git bundle and proposed full commit ID through the authenticated gateway control boundary
			And the host derives the repository and run identity from the authenticated session
			And the host never runs Git against Pi-writable repository metadata
			And the host receives the bundle into a fresh quarantine repository
			And verifies the bundle and runs Git object integrity checks
			And validates the complete proposed tree before changing the canonical repository
			And accepts regular files, executable files, and symbolic links with safe relative targets
			And rejects Git links, unsafe paths, oversized files, and a repository over its configured limit
			And executes no hook from the bundle or canonical repository
			And advances the canonical branch to the proposed head only by compare-and-swap fast-forward
			And preserves Pi's commits without creating a host merge commit
			And records the repository ID, prior head, landed head, run ID, and changed paths in the host-attested run history
			And reports success only after the canonical ref update is durable
*/
/* @covers REPO-37441347
Given a governed repository canonical branch may have advanced since a run began
	When `repo_push` proposes a head that does not descend from the current canonical head
		Then integral refuses the landing without changing the canonical repository
			And reports the current canonical head
			And permits Pi to fetch, rebase, resolve conflicts, and retry from its checkout
	When a bundle, proposed head, commit range, or tree fails validation
		Then integral refuses the landing without importing unvalidated refs into the canonical repository
			And records a redacted refusal reason in the run history
			And leaves the checkout available for Pi to correct and retry
*/
test("[REPO-403F597E] [REPO-A690931F] [REPO-CDA4609A] [REPO-7B0E2F4A] [REPO-37441347] repository work lands only through its host write policy and a validated bundle", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    resource = await createResource(
      paths,
      "host-repo",
      "source",
      "/home/pi/source",
      config,
    ),
    home = join(paths.root, "repo-home");
  await mkdir(home);
  const projection = await prepareResourceProjection(
      paths,
      config,
      home,
      "run-one",
    ),
    checkout = projection.repositories[0]!.checkout;
  await writeFile(join(checkout, "README.md"), "governed\n");
  await run("git", ["add", "README.md"], { cwd: checkout });
  await run(
    "git",
    [
      "-c",
      "user.name=Integral Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: checkout },
  );
  const proposed = (
      await run("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim(),
    bundle = join(paths.root, "proposal.bundle");
  await run("git", ["bundle", "create", bundle, "HEAD"], { cwd: checkout });
  const landed = await repositoryBundlePush(
    paths,
    config,
    resource.id,
    await readFile(bundle),
    proposed,
  );
  assert.equal(landed.landed, proposed);
  assert.deepEqual(landed.changedPaths, ["README.md"]);
  assert.equal(
    (await run("git", ["--git-dir", resource.path, "show", "main:README.md"]))
      .stdout,
    "governed\n",
  );
  await assert.rejects(
    repositoryBundlePush(
      paths,
      config,
      resource.id,
      Buffer.from("not a bundle"),
      "0".repeat(40),
    ),
  );
  await run("git", ["checkout", "--orphan", "stale"], { cwd: checkout });
  await run("git", ["rm", "-rf", "."], { cwd: checkout });
  await writeFile(join(checkout, "STALE.md"), "stale\n");
  await run("git", ["add", "STALE.md"], { cwd: checkout });
  await run(
    "git",
    [
      "-c",
      "user.name=Integral Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "stale",
    ],
    { cwd: checkout },
  );
  const stale = (
      await run("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim(),
    staleBundle = join(paths.root, "stale.bundle");
  await run("git", ["bundle", "create", staleBundle, "HEAD"], {
    cwd: checkout,
  });
  await assert.rejects(
    repositoryBundlePush(
      paths,
      config,
      resource.id,
      await readFile(staleBundle),
      stale,
    ),
    new RegExp(`current canonical head is ${proposed}`),
  );
  await writeFile(
    join(paths.resources, "source.json"),
    `${JSON.stringify({ ...resource, writePolicy: "denied" })}\n`,
  );
  await assert.rejects(
    repositoryBundlePush(
      paths,
      config,
      resource.id,
      await readFile(bundle),
      proposed,
    ),
    /writes are denied by host policy/,
  );
  const gateway = new Gateway(
    paths,
    config,
    new Logger({
      component: "gateway",
      deploymentId: deploymentId(paths),
      level: "error",
      format: "json",
      sink: () => undefined,
    }),
  );
  gateway.sessions.set("git-token", "run-one");
  const request = Readable.from(
      [],
    ) as unknown as import("node:http").IncomingMessage,
    advertised: Buffer[] = [];
  let responseStatus = 0;
  const response = {
    writeHead(status: number) {
      responseStatus = status;
      return response;
    },
    end(value?: string | Buffer) {
      if (value) advertised.push(Buffer.from(value));
      return response;
    },
  } as unknown as import("node:http").ServerResponse;
  request.url = `http://integral.control/integral/control/resources/repos/${resource.id}/git/info/refs?service=git-upload-pack`;
  request.method = "GET";
  request.headers = {
    "proxy-authorization": `Basic ${Buffer.from("integral:git-token").toString("base64")}`,
  };
  await (
    gateway as unknown as {
      route(
        request: import("node:http").IncomingMessage,
        response: import("node:http").ServerResponse,
      ): Promise<void>;
    }
  ).route(request, response);
  const advertisement = Buffer.concat(advertised).toString("utf8");
  assert.equal(responseStatus, 200);
  assert.match(advertisement, /service=git-upload-pack/);
  assert.match(advertisement, new RegExp(proposed));
  await cleanupResourceProjection(paths, config, projection);
  await rm(bundle, { force: true });
  await rm(staleBundle, { force: true });
});

/* @covers STORE-815F88A3
Given Pi writes, renames, or removes content in a mounted store whose backing identity remains reachable
	When the filesystem acknowledges the operation
		Then the change remains in the backing directory after the Pi session ends or is recycled
			And later sessions observe the resulting filesystem state
			And Integral does not parse, import, execute, or run Git against store content
			And Integral never follows a store-contained symlink while snapshotting or managing lifecycle state
			And files named `.git` or executable files receive no special host authority
	When Pi needs multi-file consistency or a read-modify-write update
		Then the store guidance requires atomic replacement where possible
			And requires an advisory store lock around the whole operation when atomic replacement is insufficient
*/
/* @covers STORE-F0338E2A
Given a governed store may have changed
	When a writable Pi run using it ends or the daily snapshot sweep runs
		And snapshots are configured
		Then integral acquires the shared whole-store lock
			And takes a filesystem snapshot without following symbolic links
			And records an itemized path change summary in host-attested run history when a run caused the snapshot
			And hard-links unchanged regular files from the preceding snapshot when the filesystem supports it
			And keeps no new snapshot when the store bytes are unchanged
			And retains the configured number of snapshots
			And excludes the host-managed lock namespace from store content and snapshots
	When snapshots are disabled
		Then integral does not snapshot or restore that store
*/
/* @covers STORE-0B28DA79
Given a governed store has one or more retained snapshots
	When Pi calls `store_snapshot_list`
		Then integral returns stable snapshot IDs, creation times, originating run IDs when present, and itemized path summaries
			And does not return snapshot host paths
	When Pi calls `store_snapshot_restore` with a snapshot ID and expected lifecycle revision
		Then integral serializes the restore against lifecycle and snapshot operations
			And takes a pre-restore snapshot of the current bytes
			And replaces store content from the requested snapshot without following symbolic links
			And preserves host-managed lock state outside the restored content
			And advances the lifecycle revision
			And marks every session carrying the store stale for shutdown or replacement
			And reports success only after the restored state and pre-restore recovery snapshot are durable
	When the snapshot or lifecycle revision is stale
		Then integral rejects restoration without changing store content
*/
test("[STORE-815F88A3] [STORE-F0338E2A] [STORE-0B28DA79] store bytes and symlinks remain inert across deduplicated snapshots and lifecycle CAS", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    resource = await createResource(
      paths,
      "host-store",
      "snapshots",
      "/home/pi/snapshots",
      config,
    );
  await writeFile(join(resource.path, "value.txt"), "one");
  const external = join(paths.root, "outside-store.txt");
  await writeFile(external, "outside");
  await symlink(external, join(resource.path, "external-link"));
  await writeFile(join(resource.path, ".git"), "inert");
  await chmod(join(resource.path, ".git"), 0o755);
  for (const [session, value] of [
    ["snapshot-one", "one"],
    ["snapshot-one-again", "one"],
    ["snapshot-two", "two"],
  ] as const) {
    await writeFile(join(resource.path, "value.txt"), value);
    const home = join(paths.root, session);
    await mkdir(home);
    await cleanupResourceProjection(
      paths,
      config,
      await prepareResourceProjection(paths, config, home, session),
    );
  }
  const snapshots = await listStoreSnapshots(paths, resource.id);
  assert.equal(snapshots.length, 2);
  assert.ok(
    snapshots.every(
      (snapshot) => !JSON.stringify(snapshot).includes(paths.root),
    ),
  );
  const restored = await restoreStoreSnapshot(
    paths,
    config,
    resource.id,
    snapshots.at(-1)!.id,
    resource.revision,
  );
  assert.equal(restored.revision, resource.revision + 1);
  assert.equal(await readFile(join(resource.path, "value.txt"), "utf8"), "one");
  assert.equal(await readFile(external, "utf8"), "outside");
  assert.equal(
    await import("node:fs/promises").then((fs) =>
      fs.readlink(join(resource.path, "external-link")),
    ),
    external,
  );
  await assert.rejects(
    restoreStoreSnapshot(
      paths,
      config,
      resource.id,
      snapshots[0]!.id,
      resource.revision,
    ),
    /stale resource revision/,
  );
});

/* @covers REPO-BB20CA23
Given a governed repository checkout differs from its landed canonical head
	When the Pi run stops, fails, times out, or is recycled
		Then integral snapshots its files without trusting or executing its `.git` metadata
			And records the snapshot in host recovery storage independent of the canonical repository
			And records whether the checkout contained committed or uncommitted changes
			And makes the recovery artifact visible in repository status for a later run
			And only then removes the temporary checkout
	When the checkout has no work beyond its landed canonical head
		Then integral removes it without creating an empty recovery artifact
	When a recovery artifact exceeds the configured retention period
		Then integral removes it without requiring or changing canonical history
			And records the expiration in host-attested repository history
*/
/* @covers REPO-1C3B9872
Given a Pi session was provisioned with a governed repository checkout
	When trusted host code detects that the canonical repository is missing, inaccessible, invalid, or replaced by another filesystem identity
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And leaves the existing Pi session and checkout running until its ordinary end
			And lets local file edits and Git commits succeed or fail normally inside that checkout
			And rejects `repo_push`, `git fetch origin`, and later host-mediated operations with `resource_unavailable`
			And preserves unlanded work in canonical-independent recovery storage when the session ends
	When integral starts a later Pi session
		Then it omits the unavailable repository
			And tells Pi the connection name and bounded availability reason without exposing its host path
*/
/* @covers REPO-CEE2CA38
Given active, unavailable, and soft-deleted governed repositories may exist
	When Pi calls `repo_list`
		Then integral returns each repository's stable ID, connection name, lifecycle state, lifecycle revision, canonical branch, and mount path
			And reports a bounded availability reason for an unavailable repository
			And identifies recovery artifacts with unlanded work
			And does not return canonical host paths or another deployment's repositories
	When Pi calls a repository tool using only a path
		Then integral requires the path to resolve to exactly one repository in the authenticated session
			And otherwise requires the stable ID or connection name
*/
test("[REPO-BB20CA23] [REPO-1C3B9872] [REPO-CEE2CA38] repository failure preserves classified recovery without exposing canonical paths", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    resource = await createResource(
      paths,
      "host-repo",
      "recoverable",
      "/home/pi/recoverable",
      config,
    ),
    home = join(paths.root, "recovery-home"),
    missing = `${resource.path}.missing`;
  t.after(() => rm(missing, { recursive: true, force: true }));
  await mkdir(home);
  const projection = await prepareResourceProjection(
      paths,
      config,
      home,
      "recovery-session",
    ),
    checkout = projection.repositories.find(
      (value) => value.resource.id === resource.id,
    )!.checkout;
  await writeFile(join(checkout, "committed.txt"), "committed");
  await run("git", ["add", "committed.txt"], { cwd: checkout });
  await run(
    "git",
    [
      "-c",
      "user.name=Integral Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "recovery",
    ],
    { cwd: checkout },
  );
  await writeFile(join(checkout, "uncommitted.txt"), "uncommitted");
  const old = join(paths.recovery, resource.id, "expired-artifact");
  await mkdir(old, { recursive: true });
  await utimes(old, new Date(0), new Date(0));
  await rename(resource.path, missing);
  const unavailable = await refreshResource(
    paths,
    (await readResource(paths, resource.connection))!,
  );
  assert.equal(unavailable.availabilityReason, "missing");
  await assert.rejects(
    repositoryBundlePush(
      paths,
      config,
      resource.id,
      Buffer.from("ignored"),
      "0".repeat(40),
    ),
    /resource_unavailable/,
  );
  const laterHome = join(paths.root, "recovery-later");
  await mkdir(laterHome);
  const later = await prepareResourceProjection(
    paths,
    config,
    laterHome,
    "later-session",
  );
  assert.deepEqual(later.unavailable, [
    { name: "recoverable", kind: "host-repo", reason: "missing" },
  ]);
  await cleanupResourceProjection(paths, config, projection);
  const recovery = await listRepositoryRecovery(paths, resource.id);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0]?.committedChanges, true);
  assert.equal(recovery[0]?.uncommittedChanges, true);
  assert.doesNotMatch(JSON.stringify(recovery), new RegExp(paths.root));
  assert.match(
    await readFile(paths.repositoryRecoveryAudit, "utf8"),
    /repository_recovery_expired/,
  );
});

/* @covers REPO-F96C6AE6
Given a governed repository has a tombstone and its canonical repository remains available
	When Pi calls `repo_restore` with its repository ID, expected lifecycle revision, and a valid mount path
		Then integral reactivates the same stable repository and canonical history
			And records the newly chosen mount path
			And marks the current session for replacement after the tool reports durable restoration
			And creates a checkout at that path before the next Pi prompt
			And advances the lifecycle revision without rewriting repository history
	When the canonical repository is missing or the requested path is invalid
		Then integral leaves the tombstone unchanged
			And reports why restoration could not complete
*/
/* @covers REPO-4EB2390E
Given a governed repository was created through Pi or added from an existing host path
	When Pi or the connection CLI performs a lifecycle operation
		Then integral applies the same states, revisions, tools, and restoration rules
			And does not record or expose an ownership or provenance classification
	When Pi soft-deletes it or the user removes its connection
		Then integral removes access and preserves a tombstone
			And never deletes, moves, rewrites, or changes filesystem ownership of the canonical repository merely because access was removed
			And a successful governed landing remains the only operation allowed to advance its selected canonical branch
*/
/* @covers REPO-D987932B
Given several Pi runs or host commands act on one governed repository concurrently
	When integral creates, adds, pushes, soft-deletes, or restores it
		Then the host serializes validation and state changes by stable repository ID
			And uses lifecycle revisions for connection-state compare-and-swap
			And uses canonical commit IDs for branch compare-and-swap
			And never exposes a partially updated connection record, canonical ref, checkout, or tombstone
			And a process restart recovers the last durable lifecycle state and canonical head
Given permanent deletion of repository content is outside the governed lifecycle
	When Pi or the connection CLI requests removal
		Then integral offers only soft deletion
			And leaves permanent canonical purging outside this phase
*/
/* @covers STORE-097B028D
Given several Pi runs or host commands act on one store concurrently
	When integral creates, adds, soft-deletes, or restores it
		Then the host serializes lifecycle changes by stable store ID
			And uses lifecycle revisions for compare-and-swap
			And never exposes a partially updated connection record, mount path, or tombstone
			And a process restart recovers the last durable lifecycle state
Given permanent deletion of store content is outside the governed lifecycle
	When Pi or the connection CLI requests removal
		Then integral offers only soft deletion
			And leaves permanent backing-directory purging outside this phase
*/
test("[REPO-F96C6AE6] [REPO-4EB2390E] [REPO-D987932B] [STORE-097B028D] lifecycle CAS serializes soft deletion and restores the same backing resource", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {});
  for (const [kind, name] of [
    ["host-repo", "serialized-repo"],
    ["host-store", "serialized-store"],
  ] as const) {
    const resource = await createResource(
        paths,
        kind,
        name,
        `/home/pi/${name}`,
        config,
      ),
      outcomes = await Promise.allSettled([
        softDeleteResource(paths, name, resource.revision, "one"),
        softDeleteResource(paths, name, resource.revision, "two"),
      ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "rejected").length,
      1,
    );
    const deleted = (await readResource(paths, name))!;
    assert.equal(deleted.state, "soft-deleted");
    const restored = await restoreResource(
      paths,
      name,
      deleted.revision,
      `/home/pi/restored-${name}`,
    );
    assert.equal(restored.id, resource.id);
    assert.equal(restored.path, resource.path);
    assert.equal(restored.revision, resource.revision + 2);
  }
});
