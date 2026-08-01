#!/usr/bin/env node

const pi =
  await import("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js");

let models;
if (pi.ModelRuntime?.create) {
  const runtime = await pi.ModelRuntime.create({ allowModelNetwork: false });
  models = runtime.getModels();
} else if (pi.AuthStorage?.inMemory && pi.ModelRegistry?.inMemory) {
  models = pi.ModelRegistry.inMemory(pi.AuthStorage.inMemory()).getAll();
} else {
  throw new Error("installed Pi does not expose a supported model catalog API");
}

process.stdout.write(
  `${JSON.stringify(
    models.map((model) => ({ provider: model.provider, model: model.id })),
  )}\n`,
);
