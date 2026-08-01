import type { EffectiveConfig } from "./config.ts";
import {
  discoverPiModels,
  discoverPiVersion,
  ensureContainerImage,
} from "./container.ts";
import { DEFAULT_PI_IMAGE } from "./constants.ts";
import { listConnections } from "./connections.ts";
import type { RrPaths } from "./paths.ts";
import { ensurePiRuntime, type PiRuntimeResolution } from "./pi-runtime.ts";

export interface ModelSelection {
  connection: string;
  provider: string;
  model: string;
  piVersion: string;
  piImage: string;
}

export type ModelChoice = ModelSelection;

export interface ModelCatalog {
  choices: ModelChoice[];
  piVersion?: string;
  piImage?: string;
  warning?: string;
}

export interface ModelCatalogDependencies {
  ensureRuntime(paths: RrPaths): Promise<PiRuntimeResolution>;
  ensureImage(
    config: EffectiveConfig,
    piVersion: string,
  ): string | Promise<string>;
  discoverModels(
    image: string,
    providers: readonly string[],
  ): Promise<Array<{ provider: string; model: string }>>;
  discoverVersion(image: string): string | Promise<string>;
}

const productionDependencies: ModelCatalogDependencies = {
  ensureRuntime: ensurePiRuntime,
  ensureImage: ensureContainerImage,
  discoverModels: discoverPiModels,
  discoverVersion: discoverPiVersion,
};

export async function listModelChoices(
  paths: RrPaths,
  config: EffectiveConfig,
  overrides: Partial<ModelCatalogDependencies> = {},
): Promise<ModelCatalog> {
  const connections = (await listConnections(paths))
    .filter(
      (connection) =>
        connection.kind === "model" && connection.state === "active",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!connections.length) return { choices: [] };
  const dependencies = { ...productionDependencies, ...overrides },
    runtime = await dependencies.ensureRuntime(paths),
    image = await dependencies.ensureImage(config, runtime.version),
    piVersion =
      config.runner.image === DEFAULT_PI_IMAGE
        ? runtime.version
        : await dependencies.discoverVersion(image),
    providers = [
      ...new Set(connections.map((connection) => connection.provider!)),
    ],
    models = await dependencies.discoverModels(image, providers),
    byProvider = new Map<string, string[]>();
  for (const { provider, model } of models) {
    const group = byProvider.get(provider) ?? [];
    group.push(model);
    byProvider.set(provider, group);
  }
  const choices = connections.flatMap((connection) =>
    [...new Set(byProvider.get(connection.provider!) ?? [])]
      .sort()
      .map((model) => ({
        connection: connection.name,
        provider: connection.provider!,
        model,
        piVersion,
        piImage: image,
      })),
  );
  return {
    choices,
    piVersion,
    piImage: image,
    ...(runtime.warning ? { warning: runtime.warning } : {}),
  };
}

export function sameSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left?.connection === right?.connection &&
    left?.provider === right?.provider &&
    left?.model === right?.model &&
    left?.piVersion === right?.piVersion &&
    left?.piImage === right?.piImage
  );
}

export function sameModel(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left?.connection === right?.connection &&
    left?.provider === right?.provider &&
    left?.model === right?.model
  );
}

export function matchModelChoices(
  choices: readonly ModelChoice[],
  terms: readonly string[],
): ModelChoice[] {
  const normalized = terms
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  if (!normalized.length) return [...choices];
  return choices.filter((choice) => {
    const fields = [choice.connection, choice.provider, choice.model].map(
      (field) => field.toLowerCase(),
    );
    return normalized.every((term) =>
      fields.some((field) => field.includes(term)),
    );
  });
}
