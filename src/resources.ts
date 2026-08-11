import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
} from "node:path";
import { promisify } from "node:util";
import type { EffectiveConfig } from "./config.ts";
import {
  migratePiProfileConnection,
  removeConnection,
  saveConnection,
  type Connection,
} from "./connections.ts";
import { IntegralError } from "./errors.ts";
import { acquireLock, atomicWrite, ensureDir, readText } from "./fs.ts";
import type { IntegralPaths } from "./paths.ts";
import {
  IMAGE_RECIPE_ID,
  IMAGE_RECIPE_MOUNT,
  IMAGE_RECIPE_NAME,
  ensureImageRecipeRepository,
  imageRecipeHead,
  materializeImageRecipe,
} from "./image-recipe.ts";

const run = promisify(execFile);

export const PI_PROFILE_NAME = "pi-profile";
export const PI_PROFILE_MOUNT = "/home/pi/.pi";
const LEGACY_PI_PROFILE_MOUNT = "/home/pi/.pi/agent";
const PI_PROFILE_CHECKOUT_EXCLUDES = [
  "/agent/auth.json",
  "/agent/sessions/",
  "/agent/npm/",
  "/agent/git/",
  "/agent/trust.json",
  "/npm/",
  "/git/",
];

export type ResourceKind = "host-repo" | "host-store";
export type ResourceState = "active" | "unavailable" | "soft-deleted";
export type AvailabilityReason =
  | "missing"
  | "wrong_type"
  | "permission_denied"
  | "identity_changed"
  | "invalid_repository"
  | "read_only"
  | "soft_deleted";

export interface BackingIdentity {
  device: string;
  inode: string;
}

export interface ResourceRecord {
  id: string;
  connection: string;
  kind: ResourceKind;
  path: string;
  mount: string;
  branch?: string;
  identity: BackingIdentity;
  state: ResourceState;
  revision: number;
  writePolicy?: "direct" | "approval-required" | "denied";
  availabilityReason?: AvailabilityReason;
  tombstone?: {
    deletedAt: string;
    actor: string;
    priorMount: string;
  };
}

export interface RepositoryProjection {
  resource: ResourceRecord;
  checkout: string;
  initialHead?: string;
}

export interface ResourceProjection {
  sessionId: string;
  repositories: RepositoryProjection[];
  stores: ResourceRecord[];
  mounts: { source: string; target: string; readonly: boolean }[];
  unavailable: Array<{
    name: string;
    kind: ResourceKind;
    reason: AvailabilityReason;
  }>;
}

function recordFile(paths: IntegralPaths, name: string): string {
  return join(paths.resources, `${name}.json`);
}

function sessionFile(
  paths: IntegralPaths,
  resourceId: string,
  sessionId: string,
): string {
  return join(paths.resourceSessions, resourceId, `${sessionId}.json`);
}

async function withResourceLock<T>(
  paths: IntegralPaths,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const digest = createHash("sha256").update(key).digest("hex"),
    lock = join(paths.storeLocks, `${digest}.lock`);
  for (let attempt = 0; ; attempt++) {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireLock(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt >= 500)
        throw new IntegralError("resource operation is busy", 409);
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    try {
      return await action();
    } finally {
      await release();
    }
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function validateMountPath(mount: string, connection?: string): string {
  if (!isAbsolute(mount) || normalize(mount) !== mount)
    throw new IntegralError("mount must be an absolute normalized path");
  if (mount === "/home/pi" || !mount.startsWith("/home/pi/"))
    throw new IntegralError("mount must be below /home/pi");
  if (connection === PI_PROFILE_NAME) {
    if (mount !== PI_PROFILE_MOUNT)
      throw new IntegralError(
        `${PI_PROFILE_NAME} must mount at ${PI_PROFILE_MOUNT}`,
      );
    return mount;
  }
  const relativeMount = mount.slice("/home/pi/".length);
  for (const reserved of [".pi", "history"]) {
    if (relativeMount === reserved || relativeMount.startsWith(`${reserved}/`))
      throw new IntegralError("mount overlaps an Integral control path");
  }
  return mount;
}

async function backingIdentity(path: string): Promise<BackingIdentity> {
  const value = await stat(path, { bigint: true });
  return { device: String(value.dev), inode: String(value.ino) };
}

function sameIdentity(a: BackingIdentity, b: BackingIdentity): boolean {
  return a.device === b.device && a.inode === b.inode;
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await run("git", args, {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return result.stdout.trim();
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    throw new IntegralError(stderr || "Git operation failed");
  }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const visit = async (path: string): Promise<void> => {
    const value = await lstat(path);
    if (value.isSymbolicLink()) return;
    if (value.isFile()) {
      total += value.size;
      return;
    }
    if (!value.isDirectory()) return;
    for (const entry of await readdir(path)) await visit(join(path, entry));
  };
  await visit(root);
  return total;
}

async function repositoryBranch(
  path: string,
  requested?: string,
): Promise<string> {
  if (
    (await git(["--git-dir", path, "rev-parse", "--is-bare-repository"])) !==
    "true"
  )
    throw new IntegralError("path is not a bare Git repository");
  const branch =
    requested ??
    (await git([
      "--git-dir",
      path,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).catch(() => "")) ??
    "";
  const selected = branch || "main";
  const refs = await git([
    "--git-dir",
    path,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
  ]);
  if (refs && !refs.split("\n").includes(`refs/heads/${selected}`))
    throw new IntegralError(`repository branch does not exist: ${selected}`);
  return selected;
}

async function validateSource(
  paths: IntegralPaths,
  connection: Connection,
  config: EffectiveConfig,
): Promise<{ path: string; identity: BackingIdentity; branch?: string }> {
  const source = connection.path!;
  if (!isAbsolute(source)) throw new IntegralError("path must be absolute");
  const canonical = await stat(source)
    .then(
      async () =>
        await import("node:fs/promises").then((fs) => fs.realpath(source)),
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new IntegralError("resource path is missing");
      throw error;
    });
  if (canonical === "/")
    throw new IntegralError("resource path must not be the filesystem root");
  const managedRoot =
    connection.kind === "host-repo" ? paths.repositories : paths.stores;
  if (
    (inside(canonical, paths.root) || inside(paths.root, canonical)) &&
    !inside(managedRoot, canonical)
  )
    throw new IntegralError(
      "resource path overlaps the Integral deployment root",
    );
  const value = await stat(canonical);
  if (!value.isDirectory())
    throw new IntegralError("resource path must be a directory");
  await access(canonical, fsConstants.R_OK | fsConstants.W_OK).catch(() => {
    throw new IntegralError("resource path must be readable and writable");
  });
  const result: { path: string; identity: BackingIdentity; branch?: string } = {
    path: canonical,
    identity: await backingIdentity(canonical),
  };
  if (connection.kind === "host-repo") {
    result.branch = await repositoryBranch(canonical, connection.branch);
    if ((await directoryBytes(canonical)) > config.repositories.maxRepoBytes)
      throw new IntegralError("repository exceeds repositories.max_repo_bytes");
  }
  return result;
}

export async function prepareResourceStorage(
  paths: IntegralPaths,
): Promise<void> {
  await Promise.all([
    ensureDir(paths.resources),
    ensureDir(paths.repositories),
    ensureDir(paths.stores),
    ensureDir(paths.recovery),
    ensureDir(paths.storeSnapshots),
    ensureDir(paths.storeLocks),
    ensureDir(paths.resourceSessions),
  ]);
}

export async function readResource(
  paths: IntegralPaths,
  name: string,
): Promise<ResourceRecord | undefined> {
  const raw = await readText(recordFile(paths, name));
  if (raw === undefined) return undefined;
  const value = JSON.parse(raw) as ResourceRecord;
  if (
    !value ||
    typeof value.id !== "string" ||
    value.connection !== name ||
    !["host-repo", "host-store"].includes(value.kind) ||
    !["active", "unavailable", "soft-deleted"].includes(value.state) ||
    !Number.isInteger(value.revision)
  )
    throw new IntegralError(`invalid resource record: ${name}`);
  value.writePolicy ??= "direct";
  return value;
}

async function writeResource(
  paths: IntegralPaths,
  value: ResourceRecord,
): Promise<void> {
  await atomicWrite(
    recordFile(paths, value.connection),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

export async function listResourceRecords(
  paths: IntegralPaths,
): Promise<ResourceRecord[]> {
  await prepareResourceStorage(paths);
  const files = (await readdir(paths.resources))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const result: ResourceRecord[] = [];
  for (const file of files) {
    const value = await readResource(paths, basename(file, ".json"));
    if (value) result.push(value);
  }
  return result;
}

async function assertNoOverlap(
  paths: IntegralPaths,
  source: string,
  mount: string,
  except?: string,
): Promise<void> {
  for (const existing of await listResourceRecords(paths)) {
    if (existing.connection === except) continue;
    if (inside(existing.path, source) || inside(source, existing.path))
      throw new IntegralError(
        `resource path overlaps connection ${existing.connection}`,
      );
    if (inside(existing.mount, mount) || inside(mount, existing.mount))
      throw new IntegralError(
        `mount overlaps connection ${existing.connection}`,
      );
  }
}

export async function addHostResource(
  paths: IntegralPaths,
  connection: Connection,
  config: EffectiveConfig,
): Promise<ResourceRecord> {
  return await withResourceLock(paths, `connection:${connection.name}`, () =>
    addHostResourceUnlocked(paths, connection, config),
  );
}

async function addHostResourceUnlocked(
  paths: IntegralPaths,
  connection: Connection,
  config: EffectiveConfig,
): Promise<ResourceRecord> {
  if (connection.kind !== "host-repo" && connection.kind !== "host-store")
    throw new IntegralError("connection is not a host resource");
  await prepareResourceStorage(paths);
  if (await readResource(paths, connection.name))
    throw new IntegralError(`connection ${connection.name} already exists`);
  if (connection.name === PI_PROFILE_NAME && connection.kind !== "host-repo")
    throw new IntegralError(`${PI_PROFILE_NAME} must be a host repository`);
  const mount = validateMountPath(connection.mount!, connection.name),
    source = await validateSource(paths, connection, config);
  await assertNoOverlap(paths, source.path, mount);
  const leases = await sessionsUsingPath(paths, source.path);
  if (leases.length)
    throw new IntegralError(
      "resource path is still referenced by an existing session",
    );
  const normalized: Connection = {
    ...connection,
    path: source.path,
    mount,
    ...(source.branch ? { branch: source.branch } : {}),
  };
  await saveConnection(paths, normalized);
  const record: ResourceRecord = {
    id: randomUUID(),
    connection: normalized.name,
    kind: normalized.kind as ResourceKind,
    path: source.path,
    mount,
    ...(source.branch ? { branch: source.branch } : {}),
    identity: source.identity,
    state: "active",
    revision: 1,
    writePolicy: "direct",
  };
  try {
    await writeResource(paths, record);
  } catch (error) {
    await removeConnection(paths, normalized.name).catch(() => undefined);
    throw error;
  }
  return record;
}

export async function createResource(
  paths: IntegralPaths,
  kind: ResourceKind,
  name: string,
  mount: string,
  config: EffectiveConfig,
): Promise<ResourceRecord> {
  await prepareResourceStorage(paths);
  const id = randomUUID(),
    source = join(kind === "host-repo" ? paths.repositories : paths.stores, id);
  if (kind === "host-repo") {
    await ensureDir(source);
    await git(["init", "--bare", "--initial-branch=main", source]);
  } else await mkdir(source, { mode: 0o700 });
  try {
    return await addHostResource(
      paths,
      {
        name,
        kind,
        auth: "none",
        path: source,
        mount,
        ...(kind === "host-repo" ? { branch: "main" } : {}),
      },
      config,
    );
  } catch (error) {
    await rm(source, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Provision Integral's sole host-known Pi profile boundary. Everything inside
 * the repository remains ordinary, opaque repository content owned by Pi.
 */
export async function ensurePiProfileRepository(
  paths: IntegralPaths,
  config: EffectiveConfig,
): Promise<ResourceRecord> {
  await prepareResourceStorage(paths);
  return await withResourceLock(
    paths,
    `connection:${PI_PROFILE_NAME}`,
    async () => {
      let existing = await readResource(paths, PI_PROFILE_NAME);
      if (existing) {
        if (
          existing.kind !== "host-repo" ||
          (existing.mount !== PI_PROFILE_MOUNT &&
            existing.mount !== LEGACY_PI_PROFILE_MOUNT) ||
          existing.branch !== "main" ||
          existing.writePolicy !== "direct" ||
          !inside(paths.repositories, existing.path)
        )
          throw new IntegralError(
            `${PI_PROFILE_NAME} has invalid host metadata`,
          );
        if (existing.mount === LEGACY_PI_PROFILE_MOUNT) {
          const migrated: ResourceRecord = {
            ...existing,
            mount: PI_PROFILE_MOUNT,
            revision: existing.revision + 1,
            ...(existing.tombstone
              ? {
                  tombstone: {
                    ...existing.tombstone,
                    priorMount: PI_PROFILE_MOUNT,
                  },
                }
              : {}),
          };
          if (existing.state !== "soft-deleted")
            await migratePiProfileConnection(paths, existing.path);
          await writeResource(paths, migrated);
          existing = migrated;
        }
        return existing;
      }

      const source = join(paths.repositories, randomUUID()),
        worktree = await mkdtemp(join(tmpdir(), "integral-pi-profile-"));
      try {
        await ensureDir(source);
        await git(["init", "--bare", "--initial-branch=main", source]);
        await git(["init", "--initial-branch=main"], worktree);
        await git(
          [
            "-c",
            "user.name=Integral",
            "-c",
            "user.email=integral@localhost",
            "commit",
            "--allow-empty",
            "-m",
            "Initialize Pi profile",
          ],
          worktree,
        );
        await git(["remote", "add", "origin", source], worktree);
        await git(["push", "origin", "main"], worktree);
        return await addHostResourceUnlocked(
          paths,
          {
            name: PI_PROFILE_NAME,
            kind: "host-repo",
            auth: "none",
            path: source,
            mount: PI_PROFILE_MOUNT,
            branch: "main",
          },
          config,
        );
      } catch (error) {
        await rm(source, { recursive: true, force: true });
        throw error;
      } finally {
        await rm(worktree, { recursive: true, force: true });
      }
    },
  );
}

async function availability(
  record: ResourceRecord,
): Promise<AvailabilityReason | undefined> {
  let value;
  try {
    value = await stat(record.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" ? "permission_denied" : "missing";
  }
  if (!value.isDirectory()) return "wrong_type";
  try {
    await access(record.path, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return record.kind === "host-store" ? "read_only" : "permission_denied";
  }
  if (!sameIdentity(await backingIdentity(record.path), record.identity))
    return "identity_changed";
  if (record.kind === "host-repo") {
    try {
      await repositoryBranch(record.path, record.branch);
    } catch {
      return "invalid_repository";
    }
  }
  return undefined;
}

export async function resourceRestorationPossible(
  record: ResourceRecord,
): Promise<boolean> {
  return record.state === "soft-deleted" && !(await availability(record));
}

export async function refreshResource(
  paths: IntegralPaths,
  record: ResourceRecord,
): Promise<ResourceRecord> {
  if (record.state === "soft-deleted") return record;
  const reason = await availability(record);
  if (!reason && record.state === "unavailable") {
    const next = {
      ...record,
      state: "active" as const,
      revision: record.revision + 1,
    };
    delete next.availabilityReason;
    await writeResource(paths, next);
    await bumpResourceGeneration(paths);
    return next;
  }
  if (reason && record.state === "active") {
    const next = {
      ...record,
      state: "unavailable" as const,
      revision: record.revision + 1,
      availabilityReason: reason,
    };
    await writeResource(paths, next);
    await bumpResourceGeneration(paths);
    return next;
  }
  return record;
}

async function bumpResourceGeneration(
  paths: IntegralPaths,
  replaceSessions = false,
): Promise<void> {
  const file = join(paths.state, "connection-generation"),
    current = Number((await readText(file))?.trim() || "0");
  const next = Number.isSafeInteger(current) ? current + 1 : 1;
  await atomicWrite(file, `${next}\n`);
  if (replaceSessions)
    await atomicWrite(join(paths.state, "session-generation"), `${next}\n`);
}

export async function softDeleteResource(
  paths: IntegralPaths,
  name: string,
  expectedRevision: number,
  actor: string,
): Promise<ResourceRecord> {
  const resource = await readResource(paths, name);
  if (!resource) throw new IntegralError(`resource not found: ${name}`, 404);
  return await withResourceLock(paths, resource.id, () =>
    softDeleteResourceUnlocked(paths, name, expectedRevision, actor),
  );
}

async function softDeleteResourceUnlocked(
  paths: IntegralPaths,
  name: string,
  expectedRevision: number,
  actor: string,
): Promise<ResourceRecord> {
  const current = await readResource(paths, name);
  if (!current) throw new IntegralError(`resource not found: ${name}`, 404);
  if (current.revision !== expectedRevision)
    throw new IntegralError(`stale resource revision: ${name}`, 409);
  if (current.state === "soft-deleted") return current;
  const next: ResourceRecord = {
    ...current,
    state: "soft-deleted",
    revision: current.revision + 1,
    tombstone: {
      deletedAt: new Date().toISOString(),
      actor,
      priorMount: current.mount,
    },
  };
  delete next.availabilityReason;
  await writeResource(paths, next);
  await bumpResourceGeneration(paths);
  return next;
}

export async function restoreResource(
  paths: IntegralPaths,
  name: string,
  expectedRevision: number,
  mount: string,
): Promise<ResourceRecord> {
  const resource = await readResource(paths, name);
  if (!resource) throw new IntegralError(`resource not found: ${name}`, 404);
  return await withResourceLock(paths, resource.id, () =>
    restoreResourceUnlocked(paths, name, expectedRevision, mount),
  );
}

async function restoreResourceUnlocked(
  paths: IntegralPaths,
  name: string,
  expectedRevision: number,
  mount: string,
): Promise<ResourceRecord> {
  const current = await readResource(paths, name);
  if (!current) throw new IntegralError(`resource not found: ${name}`, 404);
  if (current.revision !== expectedRevision)
    throw new IntegralError(`stale resource revision: ${name}`, 409);
  if (current.state !== "soft-deleted")
    throw new IntegralError(`resource is not soft-deleted: ${name}`, 409);
  const validMount = validateMountPath(mount, current.connection),
    reason = await availability({ ...current, state: "active" });
  if (reason) throw new IntegralError(`resource_unavailable: ${reason}`, 409);
  await assertNoOverlap(paths, current.path, validMount, current.connection);
  const next: ResourceRecord = {
    ...current,
    mount: validMount,
    state: "active",
    revision: current.revision + 1,
  };
  delete next.tombstone;
  delete next.availabilityReason;
  await writeResource(paths, next);
  await bumpResourceGeneration(paths, true);
  return next;
}

function checkoutPath(sessionHome: string, mount: string): string {
  return join(sessionHome, mount.slice("/home/pi/".length));
}

async function materializeRepository(
  record: ResourceRecord,
  sessionHome: string,
  sessionId: string,
): Promise<RepositoryProjection> {
  const checkout = checkoutPath(sessionHome, record.mount);
  await ensureDir(dirname(checkout));
  const branch = record.branch ?? "main",
    canonicalHead = await git([
      "--git-dir",
      record.path,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    ]).catch(() => "");
  if (canonicalHead) {
    await git([
      "clone",
      "--no-local",
      "--branch",
      branch,
      record.path,
      checkout,
    ]);
    await git(["checkout", "-b", `integral/${sessionId}`], checkout);
  } else {
    await ensureDir(checkout);
    await git(["init", "--initial-branch", `integral/${sessionId}`], checkout);
  }
  await git(["remote", "remove", "origin"], checkout).catch(() => undefined);
  await git(
    [
      "remote",
      "add",
      "origin",
      `http://integral.control/integral/control/resources/repos/${encodeURIComponent(record.id)}/git`,
    ],
    checkout,
  );
  if (record.connection === PI_PROFILE_NAME) {
    const info = join(checkout, ".git", "info");
    await ensureDir(info);
    await atomicWrite(
      join(info, "exclude"),
      `${PI_PROFILE_CHECKOUT_EXCLUDES.join("\n")}\n`,
    );
  }
  return {
    resource: record,
    checkout,
    ...(canonicalHead ? { initialHead: canonicalHead } : {}),
  };
}

export async function prepareResourceProjection(
  paths: IntegralPaths,
  config: EffectiveConfig,
  sessionHome: string,
  sessionId: string,
): Promise<ResourceProjection> {
  const result: ResourceProjection = {
    sessionId,
    repositories: [],
    stores: [],
    mounts: [],
    unavailable: [],
  };
  for (const original of await listResourceRecords(paths)) {
    const record = await refreshResource(paths, original);
    if (record.state === "unavailable") {
      result.unavailable.push({
        name: record.connection,
        kind: record.kind,
        reason: record.availabilityReason ?? "missing",
      });
      continue;
    }
    if (record.state !== "active") {
      if (record.connection === PI_PROFILE_NAME)
        result.unavailable.push({
          name: record.connection,
          kind: record.kind,
          reason: "soft_deleted",
        });
      continue;
    }
    await ensureDir(join(paths.resourceSessions, record.id));
    await atomicWrite(
      sessionFile(paths, record.id, sessionId),
      `${JSON.stringify({ sessionId, identity: record.identity, path: record.path })}\n`,
    );
    if (record.kind === "host-store") {
      result.stores.push(record);
      result.mounts.push({
        source: record.path,
        target: record.mount,
        readonly: false,
      });
    } else {
      try {
        result.repositories.push(
          await materializeRepository(record, sessionHome, sessionId),
        );
      } catch {
        await rm(sessionFile(paths, record.id, sessionId), { force: true });
        const unavailable = await markUnavailable(
          paths,
          record,
          "invalid_repository",
        );
        result.unavailable.push({
          name: unavailable.connection,
          kind: unavailable.kind,
          reason: unavailable.availabilityReason!,
        });
      }
    }
  }
  const imageHead = await ensureImageRecipeRepository(paths),
    image = await materializeImageRecipe(paths, sessionHome, sessionId),
    imageIdentity = await backingIdentity(paths.imageRecipe),
    imageResource: ResourceRecord = {
      id: IMAGE_RECIPE_ID,
      connection: IMAGE_RECIPE_NAME,
      kind: "host-repo",
      path: paths.imageRecipe,
      mount: IMAGE_RECIPE_MOUNT,
      branch: "main",
      identity: imageIdentity,
      state: "active",
      revision: 0,
      writePolicy: "approval-required",
    };
  result.repositories.push({
    resource: imageResource,
    checkout: image.checkout,
    initialHead: imageHead,
  });
  void config;
  return result;
}

async function markUnavailable(
  paths: IntegralPaths,
  record: ResourceRecord,
  reason: AvailabilityReason,
): Promise<ResourceRecord> {
  if (record.state !== "active") return record;
  const next = {
    ...record,
    state: "unavailable" as const,
    revision: record.revision + 1,
    availabilityReason: reason,
  };
  await writeResource(paths, next);
  await bumpResourceGeneration(paths);
  return next;
}

async function sessionsUsingPath(
  paths: IntegralPaths,
  path: string,
): Promise<string[]> {
  const result: string[] = [];
  for (const resource of await listResourceRecords(paths)) {
    if (resource.path !== path) continue;
    const directory = join(paths.resourceSessions, resource.id);
    for (const file of await readdir(directory).catch(() => [] as string[]))
      if (file.endsWith(".json")) result.push(basename(file, ".json"));
  }
  return result;
}

async function snapshotStore(
  paths: IntegralPaths,
  resource: ResourceRecord,
  sessionId: string,
  retention: number,
): Promise<void> {
  if (!retention) return;
  const root = join(paths.storeSnapshots, resource.id);
  await ensureDir(root);
  const existing = (await readdir(root)).sort(),
    previous = existing.at(-1);
  if (
    previous &&
    (await treeFingerprint(resource.path)) ===
      (await treeFingerprint(join(root, previous)))
  )
    return;
  const target = join(
    root,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${sessionId}`,
  );
  await cp(resource.path, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
  });
  const snapshots = (await readdir(root)).sort();
  for (const expired of snapshots.slice(
    0,
    Math.max(0, snapshots.length - retention),
  ))
    await rm(join(root, expired), { recursive: true, force: true });
}

async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name),
        relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      hash.update(relativePath).update("\0");
      if (entry.isSymbolicLink())
        hash
          .update("link\0")
          .update(await readlink(path))
          .update("\0");
      else if (entry.isDirectory()) {
        hash.update("directory\0");
        await visit(path, relativePath);
      } else if (entry.isFile())
        hash
          .update("file\0")
          .update(await readFile(path))
          .update("\0");
      else hash.update("other\0");
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

export async function cleanupResourceProjection(
  paths: IntegralPaths,
  config: EffectiveConfig,
  projection: ResourceProjection,
): Promise<void> {
  for (const repository of projection.repositories) {
    const current = await git(
      ["status", "--porcelain"],
      repository.checkout,
    ).catch(() => "unreadable");
    const head = await git(
        ["rev-parse", "--verify", "HEAD"],
        repository.checkout,
      ).catch(() => ""),
      record =
        repository.resource.id === IMAGE_RECIPE_ID
          ? undefined
          : await readResource(paths, repository.resource.connection),
      canonicalHead =
        repository.resource.id === IMAGE_RECIPE_ID
          ? await imageRecipeHead(paths).catch(() => "")
          : record
            ? await git([
                "--git-dir",
                record.path,
                "rev-parse",
                "--verify",
                `refs/heads/${record.branch ?? "main"}`,
              ]).catch(() => "")
            : "";
    if (current || head !== canonicalHead) {
      const destination = join(
        paths.recovery,
        repository.resource.id,
        `${projection.sessionId}-${Date.now()}`,
      );
      await ensureDir(dirname(destination));
      await cp(repository.checkout, destination, {
        recursive: true,
        dereference: false,
        filter: (source) =>
          relative(repository.checkout, source).split("/")[0] !== ".git",
      });
      await atomicWrite(
        join(destination, ".integral-recovery.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          resourceId: repository.resource.id,
          sessionId: projection.sessionId,
          createdAt: new Date().toISOString(),
          committedChanges: Boolean(head && head !== canonicalHead),
          uncommittedChanges: Boolean(current),
        })}\n`,
      );
    }
    await expireRecoveryArtifacts(paths, repository.resource.id, config);
    await rm(sessionFile(paths, repository.resource.id, projection.sessionId), {
      force: true,
    });
  }
  for (const store of projection.stores) {
    await withResourceLock(paths, store.id, async () => {
      const current = await readResource(paths, store.connection);
      if (
        current &&
        (await availability({ ...current, state: "active" })) === undefined
      )
        await snapshotStore(
          paths,
          current,
          projection.sessionId,
          config.stores.snapshots,
        ).catch(() => undefined);
    });
    await rm(sessionFile(paths, store.id, projection.sessionId), {
      force: true,
    });
  }
}

async function expireRecoveryArtifacts(
  paths: IntegralPaths,
  resourceId: string,
  config: EffectiveConfig,
): Promise<void> {
  const root = join(paths.recovery, resourceId),
    cutoff =
      Date.now() - config.repositories.recoveryRetentionDays * 86_400_000;
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, entry),
      value = await stat(path);
    if (value.mtimeMs < cutoff)
      await rm(path, { recursive: true, force: true }).then(async () => {
        await ensureDir(dirname(paths.repositoryRecoveryAudit));
        await appendFile(
          paths.repositoryRecoveryAudit,
          `${JSON.stringify({
            event: "repository_recovery_expired",
            resourceId,
            artifactId: entry,
            expiredAt: new Date().toISOString(),
          })}\n`,
          { mode: 0o600 },
        );
      });
  }
}

export async function resourceForId(
  paths: IntegralPaths,
  id: string,
): Promise<ResourceRecord | undefined> {
  return (await listResourceRecords(paths)).find(
    (resource) => resource.id === id,
  );
}

export async function sessionHasResource(
  paths: IntegralPaths,
  id: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await access(sessionFile(paths, id, sessionId), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function listRepositoryRecovery(
  paths: IntegralPaths,
  id: string,
): Promise<
  Array<{
    id: string;
    createdAt: string;
    committedChanges: boolean;
    uncommittedChanges: boolean;
  }>
> {
  const root = join(paths.recovery, id),
    entries = (await readdir(root).catch(() => [] as string[]))
      .sort()
      .reverse();
  return await Promise.all(
    entries.map(async (entry) => {
      const directory = join(root, entry),
        metadata = await readText(join(directory, ".integral-recovery.json")),
        parsed = metadata
          ? (JSON.parse(metadata) as {
              createdAt?: unknown;
              committedChanges?: unknown;
              uncommittedChanges?: unknown;
            })
          : undefined;
      return {
        id: entry,
        createdAt:
          typeof parsed?.createdAt === "string"
            ? parsed.createdAt
            : (await stat(directory)).mtime.toISOString(),
        committedChanges: parsed?.committedChanges === true,
        uncommittedChanges: parsed?.uncommittedChanges === true,
      };
    }),
  );
}

export interface StoreSnapshot {
  id: string;
  createdAt: string;
  sessionId?: string;
  paths: string[];
}

async function snapshotPaths(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      result.push(name);
      if (entry.isDirectory() && !entry.isSymbolicLink())
        await visit(join(directory, entry.name), name);
    }
  };
  await visit(root, "");
  return result.sort();
}

export async function listStoreSnapshots(
  paths: IntegralPaths,
  id: string,
): Promise<StoreSnapshot[]> {
  const resource = await resourceForId(paths, id);
  if (!resource || resource.kind !== "host-store")
    throw new IntegralError("store not found", 404);
  const root = join(paths.storeSnapshots, resource.id),
    entries = (await readdir(root).catch(() => [] as string[]))
      .sort()
      .reverse();
  return await Promise.all(
    entries.map(async (snapshotId) => {
      const value = await stat(join(root, snapshotId));
      const session = /-([0-9a-f-]{36})$/i.exec(snapshotId)?.[1];
      return {
        id: snapshotId,
        createdAt: value.mtime.toISOString(),
        ...(session ? { sessionId: session } : {}),
        paths: await snapshotPaths(join(root, snapshotId)),
      };
    }),
  );
}

export async function restoreStoreSnapshot(
  paths: IntegralPaths,
  config: EffectiveConfig,
  id: string,
  snapshotId: string,
  expectedRevision: number,
): Promise<ResourceRecord> {
  return await withResourceLock(paths, id, () =>
    restoreStoreSnapshotUnlocked(
      paths,
      config,
      id,
      snapshotId,
      expectedRevision,
    ),
  );
}

async function restoreStoreSnapshotUnlocked(
  paths: IntegralPaths,
  config: EffectiveConfig,
  id: string,
  snapshotId: string,
  expectedRevision: number,
): Promise<ResourceRecord> {
  if (!/^[A-Za-z0-9._-]+$/.test(snapshotId))
    throw new IntegralError("invalid snapshot ID", 400);
  const original = await resourceForId(paths, id);
  if (!original || original.kind !== "host-store")
    throw new IntegralError("store not found", 404);
  if (original.revision !== expectedRevision)
    throw new IntegralError(
      `stale resource revision: ${original.connection}`,
      409,
    );
  const current = await refreshResource(paths, original);
  if (current.state !== "active")
    throw new IntegralError(
      current.state === "soft-deleted"
        ? "resource_soft_deleted"
        : "resource_unavailable",
      409,
    );
  const source = join(paths.storeSnapshots, current.id, snapshotId);
  const sourceValue = await stat(source).catch(() => undefined);
  if (!sourceValue?.isDirectory())
    throw new IntegralError("snapshot not found", 404);
  await snapshotStore(
    paths,
    current,
    `pre-restore-${randomUUID()}`,
    Math.max(1, config.stores.snapshots),
  );
  for (const entry of await readdir(current.path))
    await rm(join(current.path, entry), { recursive: true, force: true });
  for (const entry of await readdir(source))
    await cp(join(source, entry), join(current.path, entry), {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
    });
  const next = { ...current, revision: current.revision + 1 };
  await writeResource(paths, next);
  await bumpResourceGeneration(paths, true);
  return next;
}

export async function repositoryBundlePush(
  paths: IntegralPaths,
  config: EffectiveConfig,
  id: string,
  bundle: Buffer,
  proposed: string,
): Promise<{ prior?: string; landed: string; changedPaths: string[] }> {
  return await withResourceLock(paths, id, () =>
    repositoryBundlePushUnlocked(paths, config, id, bundle, proposed),
  );
}

async function repositoryBundlePushUnlocked(
  paths: IntegralPaths,
  config: EffectiveConfig,
  id: string,
  bundle: Buffer,
  proposed: string,
): Promise<{ prior?: string; landed: string; changedPaths: string[] }> {
  const resource = await resourceForId(paths, id);
  if (!resource || resource.kind !== "host-repo")
    throw new IntegralError("repository not found", 404);
  const current = await refreshResource(paths, resource);
  if (current.state === "soft-deleted")
    throw new IntegralError("resource_soft_deleted", 409);
  if (current.state !== "active")
    throw new IntegralError("resource_unavailable", 409);
  if (current.writePolicy === "denied")
    throw new IntegralError("repository writes are denied by host policy", 403);
  if (current.writePolicy === "approval-required")
    throw new IntegralError(
      "repository requires a specialized approval-gated landing",
      409,
    );
  if (!/^[0-9a-f]{40,64}$/i.test(proposed))
    throw new IntegralError("invalid proposed commit", 400);
  if (bundle.byteLength > config.repositories.maxRepoBytes)
    throw new IntegralError("repository bundle exceeds configured limit", 413);
  const quarantine = join(paths.state, "resource-quarantine", randomUUID());
  await ensureDir(quarantine);
  const bundleFile = join(quarantine, "proposal.bundle"),
    repo = join(quarantine, "repo.git"),
    incoming = `refs/integral/incoming/${randomUUID()}`;
  try {
    await writeFile(bundleFile, bundle, { mode: 0o600 });
    await git(["init", "--bare", repo]);
    await git([
      "--git-dir",
      repo,
      "fetch",
      bundleFile,
      `${proposed}:refs/heads/proposed`,
    ]);
    await git(["--git-dir", repo, "fsck", "--strict"]);
    await validateTree(repo, proposed, config);
    const branch = current.branch ?? "main",
      prior = await git([
        "--git-dir",
        current.path,
        "rev-parse",
        "--verify",
        `refs/heads/${branch}`,
      ]).catch(() => "");
    if (prior)
      await git([
        "--git-dir",
        repo,
        "merge-base",
        "--is-ancestor",
        prior,
        proposed,
      ]).catch(() => {
        throw new IntegralError(
          `stale repository head; current canonical head is ${prior}`,
          409,
        );
      });
    const changedPaths = (
      await git([
        "--git-dir",
        repo,
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        prior ? `${prior}..${proposed}` : proposed,
      ])
    )
      .split("\n")
      .filter(Boolean);
    await git([
      "--git-dir",
      current.path,
      "fetch",
      bundleFile,
      `${proposed}:${incoming}`,
    ]);
    await git([
      "--git-dir",
      current.path,
      "update-ref",
      `refs/heads/${branch}`,
      proposed,
      prior || "0000000000000000000000000000000000000000",
    ]);
    await git(["--git-dir", current.path, "update-ref", "-d", incoming]);
    return { ...(prior ? { prior } : {}), landed: proposed, changedPaths };
  } finally {
    await git(["--git-dir", current.path, "update-ref", "-d", incoming]).catch(
      () => undefined,
    );
    await rm(quarantine, { recursive: true, force: true });
  }
}

async function validateTree(
  gitDir: string,
  proposed: string,
  config: EffectiveConfig,
): Promise<void> {
  const raw = await run(
    "git",
    ["--git-dir", gitDir, "ls-tree", "-rz", "-l", proposed],
    { encoding: "buffer", maxBuffer: config.repositories.maxRepoBytes + 1 },
  );
  let total = 0;
  for (const entry of raw.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t(.+)$/.exec(entry);
    if (!match) throw new IntegralError("invalid Git tree entry");
    const [, mode, type, , size, path] = match;
    if (type === "commit" || mode === "160000")
      throw new IntegralError(`Git links are not allowed: ${path}`);
    if (path!.split("/").some((part) => part === ".." || part === ""))
      throw new IntegralError(`unsafe repository path: ${path}`);
    if (size !== "-") {
      const bytes = Number(size);
      if (bytes > config.repositories.maxFileBytes)
        throw new IntegralError(
          `repository file exceeds configured limit: ${path}`,
        );
      total += bytes;
    }
  }
  if (total > config.repositories.maxRepoBytes)
    throw new IntegralError("repository exceeds configured limit");
}
