import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  ensurePiProfileRepository,
  listStoreSnapshots,
  prepareResourceProjection,
  readResource,
  refreshResource,
  repositoryBundlePush,
  restoreResource,
  restoreStoreSnapshot,
  sessionHasResource,
  softDeleteResource,
  PI_PROFILE_MOUNT,
  PI_PROFILE_NAME,
  validateMountPath,
} from "../src/resources.ts";
import { deploymentId } from "../src/state.ts";
import { fixture } from "./helpers.ts";

const run = promisify(execFile);

test("[REPO-515BAAB9] governed mount paths stay below the safe Pi home namespace", () => {
  assert.equal(validateMountPath("/home/pi/work/repo"), "/home/pi/work/repo");
  assert.equal(
    validateMountPath(PI_PROFILE_MOUNT, PI_PROFILE_NAME),
    PI_PROFILE_MOUNT,
  );
  assert.throws(() => validateMountPath(PI_PROFILE_MOUNT));
  assert.throws(() => validateMountPath("/home/pi/profile", PI_PROFILE_NAME));
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

test("[PROFILE-6A93810F] the host initializes the opaque Pi profile repository exactly once", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    [first, concurrent] = await Promise.all([
      ensurePiProfileRepository(paths, config),
      ensurePiProfileRepository(paths, config),
    ]);
  assert.equal(concurrent.id, first.id);
  assert.equal(first.connection, PI_PROFILE_NAME);
  assert.equal(first.kind, "host-repo");
  assert.equal(first.mount, PI_PROFILE_MOUNT);
  assert.equal(first.branch, "main");
  assert.equal(first.writePolicy, "direct");
  assert.equal(first.state, "active");
  assert.equal(
    (await run("git", ["--git-dir", first.path, "ls-tree", "main"])).stdout,
    "",
  );
  const head = (
    await run("git", ["--git-dir", first.path, "rev-parse", "main"])
  ).stdout.trim();
  assert.match(head, /^[0-9a-f]{40,64}$/);

  await writeFile(
    join(paths.resources, `${PI_PROFILE_NAME}.json`),
    `${JSON.stringify({ ...first, mount: "/home/pi/.pi/agent" })}\n`,
  );
  const declaration = join(paths.connections, `${PI_PROFILE_NAME}.toml`);
  await writeFile(
    declaration,
    (await readFile(declaration, "utf8")).replace(
      'mount = "/home/pi/.pi"',
      'mount = "/home/pi/.pi/agent"',
    ),
  );
  const migrated = await ensurePiProfileRepository(paths, config);
  assert.equal(migrated.id, first.id);
  assert.equal(migrated.mount, PI_PROFILE_MOUNT);
  assert.equal(migrated.revision, first.revision + 1);
  assert.match(
    await readFile(declaration, "utf8"),
    /mount = "\/home\/pi\/\.pi"/,
  );

  const deleted = await softDeleteResource(
    paths,
    migrated.connection,
    migrated.revision,
    "pi:test",
  );
  const afterDeletion = await ensurePiProfileRepository(paths, config);
  assert.equal(afterDeletion.id, first.id);
  assert.equal(afterDeletion.state, "soft-deleted");
  assert.equal(afterDeletion.revision, deleted.revision);
  const laterHome = join(paths.root, "deleted-profile-home");
  await mkdir(laterHome);
  const later = await prepareResourceProjection(
    paths,
    config,
    laterHome,
    "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
  );
  assert.deepEqual(later.unavailable, [
    {
      name: PI_PROFILE_NAME,
      kind: "host-repo",
      reason: "soft_deleted",
    },
  ]);
});

test("[PROFILE-3083AEEE] each run checks out the Pi profile at its native writable path", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    profile = await ensurePiProfileRepository(paths, config),
    home = join(paths.root, "profile-home");
  await mkdir(home);
  const projection = await prepareResourceProjection(
    paths,
    config,
    home,
    "abababab-abab-4bab-8bab-abababababab",
  );
  const mounted = projection.repositories.find(
    ({ resource }) => resource.connection === PI_PROFILE_NAME,
  );
  assert.ok(mounted);
  assert.equal(mounted.checkout, join(home, ".pi"));
  assert.equal(
    mounted.initialHead,
    (
      await run("git", ["--git-dir", profile.path, "rev-parse", "main"])
    ).stdout.trim(),
  );
  await writeFile(join(mounted.checkout, "pi-owned.txt"), "opaque\n");
  assert.equal(
    await readFile(join(mounted.checkout, "pi-owned.txt"), "utf8"),
    "opaque\n",
  );
  for (const ignored of [
    "agent/auth.json",
    "agent/sessions/session.jsonl",
    "agent/npm/package/package.json",
    "agent/git/github.com/example/repo/config",
    "agent/trust.json",
    "npm/package/package.json",
    "git/github.com/example/repo/config",
  ]) {
    const file = join(mounted.checkout, ignored);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "derived\n");
    await run("git", ["check-ignore", "--quiet", ignored], {
      cwd: mounted.checkout,
    });
  }
  assert.equal(
    (await run("git", ["status", "--porcelain"], { cwd: mounted.checkout }))
      .stdout,
    "?? pi-owned.txt\n",
  );

  const deleted = await softDeleteResource(
    paths,
    profile.connection,
    profile.revision,
    "pi:test",
  );
  await assert.rejects(() =>
    restoreResource(
      paths,
      profile.connection,
      deleted.revision,
      "/home/pi/profile",
    ),
  );
  const restored = await restoreResource(
    paths,
    profile.connection,
    deleted.revision,
    PI_PROFILE_MOUNT,
  );
  assert.equal(restored.mount, PI_PROFILE_MOUNT);
});

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

test("[REPO-95B5606D] [STORE-83D2CD52] soft deletion preserves current leases and backing bytes without replacing the active session", async (t) => {
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

test("[REPO-403F597E] [REPO-A690931F] [REPO-CDA4609A] [REPO-7B0E2F4A] repository work lands only through its host write policy and a validated bundle", async (t) => {
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
});

test("[STORE-F0338E2A] [STORE-0B28DA79] store snapshots deduplicate bytes and restore through lifecycle CAS", async (t) => {
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
