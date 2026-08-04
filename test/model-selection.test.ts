import assert from "node:assert/strict";
import test from "node:test";
import { saveConnection, validateConnection } from "../src/connections.ts";
import {
  listModelChoices,
  matchModelChoices,
  type ModelChoice,
} from "../src/model-selection.ts";
import { ModelSelectionStore } from "../src/queue.ts";
import { loadConfig } from "../src/config.ts";
import { fixture } from "./helpers.ts";

const choices: ModelChoice[] = [
  {
    connection: "work-codex",
    provider: "openai-codex",
    model: "gpt-5.5",
    piVersion: "1.2.3",
    piImage: "sha256:catalog",
  },
  {
    connection: "work-codex",
    provider: "openai-codex",
    model: "gpt-5.4-mini",
    piVersion: "1.2.3",
    piImage: "sha256:catalog",
  },
  {
    connection: "personal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    piVersion: "1.2.3",
    piImage: "sha256:catalog",
  },
];

test("[CHAT-C53A90D2] model search matches case-insensitive terms across connection, provider, and model fields", () => {
  assert.deepEqual(matchModelChoices(choices, ["CODEX", "5.5"]), [choices[0]]);
  assert.deepEqual(matchModelChoices(choices, ["anth", "sonnet"]), [
    choices[2],
  ]);
  assert.deepEqual(matchModelChoices(choices, ["gpt"]), choices.slice(0, 2));
  assert.deepEqual(matchModelChoices(choices, ["missing"]), []);
});

test("[BOX-E1F472A1] [CHAT-C53A90D2] [LOG-28BE37DE] active model connections expose choices and report discovery progress without credentials", async (t) => {
  const paths = await fixture(t);
  await saveConnection(
    paths,
    validateConnection({
      name: "personal",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "secret",
  );
  const config = await loadConfig(paths, {}),
    progress: string[] = [],
    catalog = await listModelChoices(
      paths,
      config,
      {
        ensureRuntime: async () => ({
          version: "1.2.3",
          packageRoot: "/unused",
        }),
        ensureImage: () => "sha256:catalog",
        discoverModels: async () => [
          { provider: "anthropic", model: "claude-sonnet-4-6" },
        ],
      },
      (stage) => progress.push(stage),
    ),
    available = catalog.choices;
  assert.deepEqual(progress, [
    "runtime.resolve",
    "runtime.ready",
    "image.resolve",
    "image.ready",
    "models.discover",
    "models.ready",
  ]);
  assert.equal(catalog.piVersion, "1.2.3");
  assert.equal(catalog.piImage, "sha256:catalog");
  assert.ok(available.length > 0);
  assert.ok(
    available.every(
      (choice) =>
        choice.connection === "personal" && choice.provider === "anthropic",
    ),
  );
  assert.ok(available.some((choice) => /claude/i.test(choice.model)));
  assert.ok(
    available.every((choice) => !Object.values(choice).includes("secret")),
  );
});

test("[CHAT-6E91B4C7] conversation model selection is durable outside main configuration", async (t) => {
  const paths = await fixture(t),
    selection = {
      connection: "personal",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      piVersion: "1.2.3",
      piImage: "sha256:catalog",
    },
    first = new ModelSelectionStore(paths.modelSelection);
  await first.set(selection);
  const restored = new ModelSelectionStore(paths.modelSelection);
  await restored.load();
  assert.deepEqual(restored.get(), selection);
  assert.notEqual(paths.modelSelection, paths.mainConfig);
});
