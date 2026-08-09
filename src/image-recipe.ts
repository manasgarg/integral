import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EffectiveConfig } from "./config.ts";
import { DEFAULT_PI_IMAGE, INTEGRAL_VERSION } from "./constants.ts";
import { IntegralError } from "./errors.ts";
import { acquireLock, ensureDir } from "./fs.ts";
import type { IntegralPaths } from "./paths.ts";

const run = promisify(execFile);
export const IMAGE_RECIPE_ID = "integral-image-recipe";
export const IMAGE_RECIPE_NAME = "image-recipe";
export const IMAGE_RECIPE_MOUNT = "/home/pi/image";

export interface ImageProposal {
  baseCommit: string;
  proposedCommit: string;
  proposalRef: string;
  treeDigest: string;
  changedPaths: string[];
  diff: string;
}

export interface ImageBuildResult {
  recipeCommit: string;
  image: string;
  piVersion: string;
  packages: string[];
}

export interface ImageBuildAuditContext {
  priorImage?: string;
  approvalId?: string;
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await run("git", args, {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
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
    throw new IntegralError(stderr || "image recipe Git operation failed");
  }
}

function bundledDockerfile(): string {
  return fileURLToPath(new URL("../../Dockerfile.pi", import.meta.url));
}

function modelBridge(): string {
  return fileURLToPath(
    new URL("../../bin/integral-pi-models.mjs", import.meta.url),
  );
}

export async function ensureImageRecipeRepository(
  paths: IntegralPaths,
): Promise<string> {
  const ready = await stat(paths.imageRecipe)
    .then((value) => value.isDirectory())
    .catch(() => false);
  if (ready) return await imageRecipeHead(paths);
  await ensureDir(paths.state);
  const lock = join(paths.state, "image-recipe-init.lock");
  for (let attempt = 0; ; attempt++) {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireLock(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 500)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    try {
      return await ensureImageRecipeRepositoryUnlocked(paths);
    } finally {
      await release();
    }
  }
}

async function ensureImageRecipeRepositoryUnlocked(
  paths: IntegralPaths,
): Promise<string> {
  const exists = await stat(paths.imageRecipe)
    .then((value) => value.isDirectory())
    .catch(() => false);
  if (exists) {
    await git([
      "--git-dir",
      paths.imageRecipe,
      "rev-parse",
      "--is-bare-repository",
    ]);
    return await imageRecipeHead(paths);
  }
  await ensureDir(dirname(paths.imageRecipe));
  const working = await mkdtemp(join(tmpdir(), "integral-image-seed-"));
  try {
    await git(["init", "--initial-branch", "main"], working);
    await copyFile(bundledDockerfile(), join(working, "Dockerfile"));
    await git(["add", "Dockerfile"], working);
    await git(
      [
        "-c",
        "user.name=Integral",
        "-c",
        "user.email=integral@localhost",
        "commit",
        "-m",
        "Initialize managed Pi image recipe",
      ],
      working,
    );
    await git([
      "init",
      "--bare",
      "--initial-branch",
      "main",
      paths.imageRecipe,
    ]);
    await git(["remote", "add", "origin", paths.imageRecipe], working);
    await git(["push", "origin", "HEAD:main"], working);
  } finally {
    await rm(working, { recursive: true, force: true });
  }
  return await imageRecipeHead(paths);
}

export async function imageRecipeHead(paths: IntegralPaths): Promise<string> {
  return await git([
    "--git-dir",
    paths.imageRecipe,
    "rev-parse",
    "--verify",
    "refs/heads/main",
  ]);
}

export async function imageRecipeTreeDigest(
  paths: IntegralPaths,
  commit?: string,
): Promise<string> {
  const selected = commit ?? (await ensureImageRecipeRepository(paths));
  return await git([
    "--git-dir",
    paths.imageRecipe,
    "rev-parse",
    `${selected}^{tree}`,
  ]);
}

export async function materializeImageRecipe(
  paths: IntegralPaths,
  sessionHome: string,
  sessionId: string,
): Promise<{ checkout: string; head: string }> {
  const head = await ensureImageRecipeRepository(paths),
    checkout = join(sessionHome, "image");
  await git([
    "clone",
    "--no-local",
    "--branch",
    "main",
    paths.imageRecipe,
    checkout,
  ]);
  await git(["checkout", "-b", `integral/${sessionId}`], checkout);
  await git(["config", "user.name", "Pi"], checkout);
  await git(["config", "user.email", "pi@integral.local"], checkout);
  await git(["remote", "remove", "origin"], checkout);
  await git(
    [
      "remote",
      "add",
      "origin",
      `http://integral.control/integral/control/resources/repos/${IMAGE_RECIPE_ID}/git`,
    ],
    checkout,
  );
  return { checkout, head };
}

export async function validateImageDockerfile(source: string): Promise<void> {
  if (!source.trim() || Buffer.byteLength(source) > 1_000_000)
    throw new IntegralError("image Dockerfile must be between 1 byte and 1 MB");
  const baseline = await readFile(bundledDockerfile(), "utf8"),
    requiredFrom = baseline.match(/^FROM\s+\S+/m)?.[0],
    from = source.match(/^FROM\s+\S+/gm) ?? [];
  if (!requiredFrom || from.length !== 1 || from[0] !== requiredFrom)
    throw new IntegralError(
      `image Dockerfile must retain the foundational boundary: ${requiredFrom}`,
    );
  const users = source.match(/^USER\s+\S+\s*$/gm) ?? [],
    workdirs = source.match(/^WORKDIR\s+\S+\s*$/gm) ?? [];
  if (users.at(-1) !== "USER 1000:1000")
    throw new IntegralError(
      "image Dockerfile must retain USER 1000:1000 as its effective runtime user",
    );
  if (workdirs.at(-1) !== "WORKDIR /home/pi")
    throw new IntegralError(
      "image Dockerfile must retain WORKDIR /home/pi as its effective workdir",
    );
  if (/^(?:ENTRYPOINT|CMD|ONBUILD)\s+/m.test(source))
    throw new IntegralError(
      "image Dockerfile may not override Integral's runtime command boundary",
    );
  const transfers = source.match(/^(?:ADD|COPY)\s+.*$/gm) ?? [];
  if (
    transfers.some(
      (line) =>
        line.trim() !==
        "COPY --chmod=0555 bin/integral-pi-models.mjs /usr/local/bin/integral-pi-models",
    )
  )
    throw new IntegralError(
      "image Dockerfile may only copy Integral's declared model bridge",
    );
}

async function validateCommit(
  gitDir: string,
  commit: string,
): Promise<{ treeDigest: string; dockerfile: string }> {
  if (!/^[0-9a-f]{40,64}$/i.test(commit))
    throw new IntegralError("invalid image recipe commit", 400);
  const files = (
    await git(["--git-dir", gitDir, "ls-tree", "-r", "--name-only", commit])
  )
    .split("\n")
    .filter(Boolean);
  if (files.length !== 1 || files[0] !== "Dockerfile")
    throw new IntegralError("image recipe must contain only Dockerfile");
  const dockerfile = await git([
    "--git-dir",
    gitDir,
    "show",
    `${commit}:Dockerfile`,
  ]);
  await validateImageDockerfile(dockerfile);
  return {
    treeDigest: await git([
      "--git-dir",
      gitDir,
      "rev-parse",
      `${commit}^{tree}`,
    ]),
    dockerfile,
  };
}

export async function stageImageProposal(
  paths: IntegralPaths,
  bundle: Buffer,
  proposed: string,
): Promise<ImageProposal> {
  if (bundle.byteLength > 32 * 1024 * 1024)
    throw new IntegralError("image recipe bundle is too large", 413);
  const baseCommit = await ensureImageRecipeRepository(paths),
    quarantine = await mkdtemp(join(tmpdir(), "integral-image-proposal-")),
    bundleFile = join(quarantine, "proposal.bundle"),
    repo = join(quarantine, "repo.git"),
    proposalRef = `refs/integral/proposals/${randomUUID()}`;
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
    await git([
      "--git-dir",
      repo,
      "merge-base",
      "--is-ancestor",
      baseCommit,
      proposed,
    ]);
    const { treeDigest } = await validateCommit(repo, proposed),
      changedPaths = (
        await git([
          "--git-dir",
          repo,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          `${baseCommit}..${proposed}`,
        ])
      )
        .split("\n")
        .filter(Boolean),
      diff = await git([
        "--git-dir",
        repo,
        "diff",
        "--no-ext-diff",
        "--no-color",
        `${baseCommit}..${proposed}`,
        "--",
        "Dockerfile",
      ]);
    await git([
      "--git-dir",
      paths.imageRecipe,
      "fetch",
      bundleFile,
      `${proposed}:${proposalRef}`,
    ]);
    return {
      baseCommit,
      proposedCommit: proposed,
      proposalRef,
      treeDigest,
      changedPaths,
      diff,
    };
  } finally {
    await rm(quarantine, { recursive: true, force: true });
  }
}

export async function activateImageProposal(
  paths: IntegralPaths,
  proposal: ImageProposal,
): Promise<void> {
  const current = await imageRecipeHead(paths);
  if (current !== proposal.baseCommit)
    throw new IntegralError(
      `image recipe proposal is stale: expected ${proposal.baseCommit}, current ${current}`,
      409,
    );
  const actual = await git([
    "--git-dir",
    paths.imageRecipe,
    "rev-parse",
    "--verify",
    proposal.proposalRef,
  ]);
  if (actual !== proposal.proposedCommit)
    throw new IntegralError("image recipe proposal ref changed", 409);
  const validated = await validateCommit(paths.imageRecipe, actual);
  if (validated.treeDigest !== proposal.treeDigest)
    throw new IntegralError("image recipe proposal tree changed", 409);
  await git([
    "--git-dir",
    paths.imageRecipe,
    "update-ref",
    "refs/heads/main",
    proposal.proposedCommit,
    proposal.baseCommit,
  ]);
}

export async function imageRecipeDockerfile(
  paths: IntegralPaths,
  commit?: string,
): Promise<string> {
  const selected = commit ?? (await ensureImageRecipeRepository(paths));
  return await git([
    "--git-dir",
    paths.imageRecipe,
    "show",
    `${selected}:Dockerfile`,
  ]);
}

export async function commitImageDockerfile(
  paths: IntegralPaths,
  source: string,
  actor: string,
): Promise<{ prior: string; landed: string; treeDigest: string }> {
  await validateImageDockerfile(source);
  const prior = await ensureImageRecipeRepository(paths),
    working = await mkdtemp(join(tmpdir(), "integral-image-edit-"));
  try {
    await git(["clone", "--no-local", paths.imageRecipe, working]);
    await writeFile(join(working, "Dockerfile"), source);
    const changed = await git(["status", "--porcelain"], working);
    if (!changed)
      return {
        prior,
        landed: prior,
        treeDigest: await git([
          "--git-dir",
          paths.imageRecipe,
          "rev-parse",
          `${prior}^{tree}`,
        ]),
      };
    await git(["add", "Dockerfile"], working);
    await git(
      [
        "-c",
        `user.name=${actor}`,
        "-c",
        "user.email=operator@integral.local",
        "commit",
        "-m",
        "Update managed Pi image recipe",
      ],
      working,
    );
    const landed = await git(["rev-parse", "HEAD"], working);
    await git(["push", "origin", "HEAD:main"], working);
    const treeDigest = await git(["rev-parse", "HEAD^{tree}"], working);
    await appendImageAudit(paths, {
      action: "recipe.edit",
      actor,
      prior,
      landed,
      treeDigest,
    });
    return { prior, landed, treeDigest };
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

export async function buildImageRecipe(
  paths: IntegralPaths,
  config: EffectiveConfig,
  commit: string,
  actor: string,
  audit: ImageBuildAuditContext = {},
): Promise<ImageBuildResult> {
  if (config.runner.image !== DEFAULT_PI_IMAGE)
    throw new IntegralError(
      "image recipes can only build Integral's managed Pi image",
      409,
    );
  await ensureImageRecipeRepository(paths);
  const validated = await validateCommit(paths.imageRecipe, commit),
    foundationalImageReference =
      validated.dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
  const context = await mkdtemp(join(tmpdir(), "integral-image-build-")),
    tag = `integral-pi:${INTEGRAL_VERSION}-image-${commit.slice(0, 12)}`;
  try {
    const dockerfile = await imageRecipeDockerfile(paths, commit);
    await writeFile(join(context, "Dockerfile"), `${dockerfile.trimEnd()}\n`);
    await mkdir(join(context, "bin"), { recursive: true });
    await copyFile(
      modelBridge(),
      join(context, "bin", "integral-pi-models.mjs"),
    );
    const built = spawnSync(
      "docker",
      [
        "build",
        "--pull",
        "--no-cache",
        "--memory",
        `${config.runner.memoryMb}m`,
        "--label",
        `org.pirogram.integral.recipe=${commit}`,
        "--tag",
        tag,
        "--file",
        join(context, "Dockerfile"),
        context,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 1_800_000 },
    );
    if (built.status !== 0)
      throw new IntegralError(
        `image recipe build failed: ${built.stderr.trim()}`,
      );
    const inspected = spawnSync(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", tag],
      { encoding: "utf8" },
    );
    if (inspected.status !== 0 || !inspected.stdout.trim())
      throw new IntegralError("built image identity is unavailable");
    const version = spawnSync(
        "docker",
        ["run", "--rm", "--network", "none", tag, "pi", "--version"],
        {
          encoding: "utf8",
        },
      ),
      inventory = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          tag,
          "dpkg-query",
          "-W",
          "-f=${Package}=${Version}\\n",
        ],
        { encoding: "utf8" },
      );
    if (version.status !== 0 || inventory.status !== 0)
      throw new IntegralError("built image package inventory is unavailable");
    const piVersion = version.stdout
      .trim()
      .match(/\d+\.\d+\.\d+(?:[-+][^\s]+)?/)?.[0];
    if (!piVersion) throw new IntegralError("built Pi version is unavailable");
    const result = {
      recipeCommit: commit,
      image: inspected.stdout.trim(),
      piVersion,
      packages: inventory.stdout.trim().split("\n").filter(Boolean).sort(),
    };
    await appendImageAudit(paths, {
      action: "image.build",
      actor,
      ...audit,
      foundationalImageReference,
      treeDigest: validated.treeDigest,
      ...result,
    });
    return result;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export async function appendImageAudit(
  paths: IntegralPaths,
  value: Record<string, unknown>,
): Promise<void> {
  await ensureDir(dirname(paths.imageAudit));
  await appendFile(
    paths.imageAudit,
    `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), ...value })}\n`,
    { mode: 0o600 },
  );
  const handle = await open(paths.imageAudit, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
