import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  activateImageProposal,
  commitImageDockerfile,
  ensureImageRecipeRepository,
  imageRecipeDockerfile,
  imageRecipeHead,
  materializeImageRecipe,
  stageImageProposal,
  validateImageDockerfile,
} from "../src/image-recipe.ts";
import { fixture } from "./helpers.ts";

const run = promisify(execFile);

test("[BOX-6A91C3E7] the host-managed image recipe is projected as an isolated writable Git checkout", async (t) => {
  const paths = await fixture(t),
    head = await ensureImageRecipeRepository(paths),
    sessionHome = join(paths.state, "session-home"),
    projection = await materializeImageRecipe(paths, sessionHome, "session-1");
  assert.equal(projection.head, head);
  assert.equal(projection.checkout, join(sessionHome, "image"));
  assert.match(
    await readFile(join(projection.checkout, "Dockerfile"), "utf8"),
    /PI_VERSION=latest/,
  );
  assert.equal(
    (
      await run("git", ["remote", "get-url", "origin"], {
        cwd: projection.checkout,
      })
    ).stdout.trim(),
    "http://integral.control/integral/control/resources/repos/integral-image-recipe/git",
  );
});

test("[REPO-7B0E2F4A] an image recipe proposal is validated and quarantined until its exact commit is activated", async (t) => {
  const paths = await fixture(t),
    base = await ensureImageRecipeRepository(paths),
    sessionHome = join(paths.state, "proposal-home"),
    { checkout } = await materializeImageRecipe(
      paths,
      sessionHome,
      "session-2",
    ),
    dockerfile = join(checkout, "Dockerfile"),
    source = await readFile(dockerfile, "utf8");
  await writeFile(
    dockerfile,
    source.replace(
      "USER 1000:1000",
      "RUN npm install --global cowsay@latest\n\nUSER 1000:1000",
    ),
  );
  await run("git", ["add", "Dockerfile"], { cwd: checkout });
  await run("git", ["commit", "-m", "Add floating package"], {
    cwd: checkout,
  });
  const proposed = (
      await run("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim(),
    bundle = join(paths.state, "proposal.bundle");
  await run("git", ["bundle", "create", bundle, "HEAD"], { cwd: checkout });
  const staged = await stageImageProposal(
    paths,
    await readFile(bundle),
    proposed,
  );
  assert.equal(staged.baseCommit, base);
  assert.equal(staged.proposedCommit, proposed);
  assert.deepEqual(staged.changedPaths, ["Dockerfile"]);
  assert.match(staged.diff, /cowsay@latest/);
  assert.equal(await imageRecipeHead(paths), base);

  await activateImageProposal(paths, staged);
  assert.equal(await imageRecipeHead(paths), proposed);
});

test("[CLI-5D8A1C72] direct Dockerfile commits retain the foundational boundary", async (t) => {
  const paths = await fixture(t),
    source = await imageRecipeDockerfile(paths),
    updated = source.replace("ARG PI_VERSION=latest", "ARG PI_VERSION=0.85.0"),
    committed = await commitImageDockerfile(paths, updated, "operator");
  assert.notEqual(committed.prior, committed.landed);
  assert.match(await imageRecipeDockerfile(paths), /PI_VERSION=0\.85\.0/);
  const unchanged = await commitImageDockerfile(paths, updated, "operator");
  assert.equal(unchanged.prior, unchanged.landed);
  await assert.rejects(
    commitImageDockerfile(
      paths,
      updated.replace("FROM node:24.15.0-slim", "FROM alpine:latest"),
      "operator",
    ),
    /foundational boundary/,
  );
  assert.equal(await imageRecipeHead(paths), committed.landed);
});

test("[BOX-6A91C3E7] image recipe validation rejects unsafe build boundaries before approval", async (t) => {
  const paths = await fixture(t),
    source = await imageRecipeDockerfile(paths);
  await assert.rejects(validateImageDockerfile(""), /between 1 byte and 1 MB/);
  await assert.rejects(
    validateImageDockerfile(source.replace("USER 1000:1000", "USER root")),
    /retain USER/,
  );
  await assert.rejects(
    validateImageDockerfile(
      source.replace(
        "USER 1000:1000",
        "COPY secret /tmp/secret\n\nUSER 1000:1000",
      ),
    ),
    /may only copy/,
  );
  await assert.rejects(
    validateImageDockerfile(
      source.replace("WORKDIR /home/pi", "WORKDIR /workspace"),
    ),
    /retain WORKDIR/,
  );
  await assert.rejects(
    validateImageDockerfile(`${source}\nUSER root\n`),
    /effective runtime user/,
  );
  await assert.rejects(
    validateImageDockerfile(`${source}\nWORKDIR /workspace\n`),
    /effective workdir/,
  );
  await assert.rejects(
    validateImageDockerfile(`${source}\nENTRYPOINT ["sh"]\n`),
    /runtime command boundary/,
  );
});
