import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type EffectiveConfig } from "../config.ts";
import { IntegralError } from "../errors.ts";
import { atomicWrite } from "../fs.ts";
import {
  buildImageRecipe,
  commitImageDockerfile,
  ensureImageRecipeRepository,
  imageRecipeDockerfile,
} from "../image-recipe.ts";
import type { IntegralPaths } from "../paths.ts";
import { resolvePaths } from "../paths.ts";
import { ModelSelectionStore } from "../queue.ts";

const HELP = `Usage: integral image <command>

Commands:
  edit       edit and directly commit the managed Pi Dockerfile
  rebuild    directly perform a fresh pull and no-cache image build

These are privileged local operator actions. They do not create approval requests.
Pi and remote automation image requests still require human approval.
`;

export interface ImageCommandDependencies {
  resolvePaths(): IntegralPaths;
  loadConfig(paths: IntegralPaths): Promise<EffectiveConfig>;
  edit(
    paths: IntegralPaths,
    actor: string,
  ): Promise<{ prior: string; landed: string }>;
  rebuild(
    paths: IntegralPaths,
    config: EffectiveConfig,
    actor: string,
  ): Promise<{ recipeCommit: string; piVersion: string; image: string }>;
  actor(): string;
  writeOutput(text: string): void;
}

async function editImageRecipe(
  paths: IntegralPaths,
  actor: string,
): Promise<{ prior: string; landed: string }> {
  await ensureImageRecipeRepository(paths);
  const temporary = await mkdtemp(join(tmpdir(), "integral-image-edit-")),
    file = join(temporary, "Dockerfile");
  try {
    await writeFile(
      file,
      `${(await imageRecipeDockerfile(paths)).trimEnd()}\n`,
    );
    const editor = process.env.EDITOR?.trim() || process.env.VISUAL?.trim();
    if (!editor)
      throw new IntegralError(
        "EDITOR or VISUAL must name the Dockerfile editor",
      );
    const edited = spawnSync(editor, [file], { stdio: "inherit" });
    if (edited.error) throw edited.error;
    if (edited.status !== 0)
      throw new IntegralError(
        `image editor exited with status ${edited.status}`,
      );
    return await commitImageDockerfile(
      paths,
      await readFile(file, "utf8"),
      actor,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function rebuildImageRecipe(
  paths: IntegralPaths,
  config: EffectiveConfig,
  actor: string,
): Promise<{ recipeCommit: string; piVersion: string; image: string }> {
  const selection = new ModelSelectionStore(paths.modelSelection);
  await selection.load();
  const current = selection.get();
  if (!current)
    throw new IntegralError(
      "select a model before rebuilding the Pi image",
      409,
    );
  const recipeCommit = await ensureImageRecipeRepository(paths),
    result = await buildImageRecipe(paths, config, recipeCommit, actor, {
      priorImage: current.piImage,
    });
  await atomicWrite(
    paths.activeImage,
    `${JSON.stringify({ schemaVersion: 1, recipeCommit, result })}\n`,
  );
  await selection.set({
    ...current,
    piVersion: result.piVersion,
    piImage: result.image,
  });
  const generationFile = join(paths.state, "session-generation"),
    currentGeneration = Number(
      (await readFile(generationFile, "utf8").catch(() => "0")).trim() || "0",
    );
  await atomicWrite(
    generationFile,
    `${Number.isSafeInteger(currentGeneration) ? currentGeneration + 1 : 1}\n`,
  );
  return result;
}

const productionDependencies: ImageCommandDependencies = {
  resolvePaths,
  loadConfig,
  edit: editImageRecipe,
  rebuild: rebuildImageRecipe,
  actor: () => process.env.USER?.trim() || "local-operator",
  writeOutput: (text) => process.stdout.write(text),
};

export async function imageCommand(
  args: string[],
  overrides: Partial<ImageCommandDependencies> = {},
): Promise<number> {
  const dependencies = { ...productionDependencies, ...overrides };
  if (
    !args[0] ||
    args.includes("--help") ||
    args.includes("-h") ||
    args[0] === "help"
  ) {
    dependencies.writeOutput(HELP);
    return 0;
  }
  const paths = dependencies.resolvePaths(),
    config = await dependencies.loadConfig(paths),
    actor = dependencies.actor();
  if (args[0] === "edit") {
    const result = await dependencies.edit(paths, actor);
    dependencies.writeOutput(
      result.prior === result.landed
        ? "Image Dockerfile unchanged.\n"
        : `Updated image Dockerfile to ${result.landed}.\n`,
    );
    return 0;
  }
  if (args[0] === "rebuild") {
    const result = await dependencies.rebuild(paths, config, actor);
    dependencies.writeOutput(
      `Built Pi ${result.piVersion} from recipe ${result.recipeCommit}: ${result.image}\n`,
    );
    return 0;
  }
  throw new IntegralError(`unknown image command: ${args[0]}`);
}
