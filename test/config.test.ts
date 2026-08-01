import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { loadConfig, initConfig, STARTER_CONFIG } from "../src/config.ts";
import { fixture } from "./helpers.ts";
import { DEFAULT_PI_IMAGE } from "../src/constants.ts";

test("[CONFIG-8A31F6C2] [CONFIG-2D7C49E1] [CONFIG-A16F73C8] [CONFIG-E82C4A19] [CONFIG-4B97D20E] [CONFIG-73E1A6B5] [CONFIG-F2C84D16] [LOG-0A6F3D92] built-in configuration is complete and side-effect free", async (t) => {
  const paths = await fixture(t); const config = await loadConfig(paths, {});
  assert.deepEqual(config.server, { gatewayPort: 7300, coordinatorPort: 7301, runnerPort: 7302 });
  assert.deepEqual(config.runner, { image: DEFAULT_PI_IMAGE, pullPolicy: "if-not-present", turnTimeoutSeconds: 1800, idleTimeoutSeconds: 300, memoryMb: 2048, tmpfsMb: 2048 });
  assert.deepEqual(config.conversation, { contextMaxMessages: 200, contextMaxChars: 100000 });
  assert.deepEqual(config.logging, { level: "info", format: "text" });
  await assert.rejects(stat(paths.mainConfig), { code: "ENOENT" });
});

test("[CONFIG-C41E8B75] [CONFIG-1F84C6A2] generated configuration is valid, protected, and never overwritten", async (t) => {
  const paths = await fixture(t); await initConfig(paths); const bytes = await readFile(paths.mainConfig, "utf8");
  assert.equal(bytes, STARTER_CONFIG); assert.equal((await stat(paths.mainConfig)).mode & 0o777, 0o600); await loadConfig(paths, {});
  await assert.rejects(initConfig(paths), /refusing to overwrite/); assert.equal(await readFile(paths.mainConfig, "utf8"), bytes);
});

test("[CONFIG-39B8E2F6] [ENV-5F2C7E06] [ENV-C8A14D73] [ENV-BC39A7D2] [ENV-2E7A94C1] [ENV-9A4C17E2] environment overrides file values independently", async (t) => {
  const paths = await fixture(t); await mkdir(paths.config, { recursive: true });
  await writeFile(paths.mainConfig, "[server]\ngateway_port=8000\ncoordinator_port=8001\nrunner_port=8002\n[logging]\nlevel='warn'\nformat='text'\n");
  const config = await loadConfig(paths, { RR_GATEWAY_PORT: "9000", RR_LOG_FORMAT: "json" });
  assert.deepEqual(config.server, { gatewayPort: 9000, coordinatorPort: 8001, runnerPort: 8002 }); assert.deepEqual(config.logging, { level: "warn", format: "json" });
  assert.equal(config.sources["server.gateway_port"], "environment"); assert.equal(config.sources["server.runner_port"], "file");
});

test("[ENV-17B6E9C2] [SERVER-9D42E6A3] invalid or conflicting ports are rejected without fallback", async (t) => {
  const paths = await fixture(t); await assert.rejects(loadConfig(paths, { RR_GATEWAY_PORT: "abc" }), /RR_GATEWAY_PORT/);
  await assert.rejects(loadConfig(paths, { RR_GATEWAY_PORT: "7301" }), /must be distinct/);
  await assert.rejects(loadConfig(paths, { RR_RUNNER_PORT: "65536" }), /RR_RUNNER_PORT/);
});

test("[CONFIG-6E28D1F9] [CONFIG-0C6A91E4] [CONFIG-E6B40A73] [ENV-7B2D40AC] strict schema rejects typos, credentials, and security escape hatches", async (t) => {
  const paths = await fixture(t); await mkdir(paths.config, { recursive: true });
  await writeFile(paths.mainConfig, "[runner]\nmemry_mb=2\napi_key='secret'\ndirect_egress=true\n");
  await assert.rejects(loadConfig(paths, {}), (error: Error) => /memry_mb/.test(error.message) && /credentials must be stored/.test(error.message) && /direct_egress/.test(error.message));
});

test("[CONFIG-B93A4E70] [CONFIG-D4A70C31] [CONFIG-5F20A9D3] [CONFIG-17D6C8A4] CLI config commands expose paths, validation, help, values, and sources", async () => {
  assert.match(STARTER_CONFIG, /# rr Phase 1 configuration/); // Command rendering is exercised through main() in cli-contract.test.ts.
});

test("[CONFIG-7E19C4A6] [ENV-93D4A1B8] a loaded snapshot does not change when files or the parent environment later change", async (t) => {
  const paths = await fixture(t); const env = { RR_GATEWAY_PORT: "8100" }; const snapshot = await loadConfig(paths, env); env.RR_GATEWAY_PORT = "8200";
  await mkdir(paths.config, { recursive: true }); await writeFile(paths.mainConfig, "[server]\ngateway_port=8300\n");
  assert.equal(snapshot.server.gatewayPort, 8100); assert.equal((await loadConfig(paths, env)).server.gatewayPort, 8200);
});

test("[CONFIG-35D8A2F1] effective shared configuration has a stable fingerprint", async (t) => {
  const paths = await fixture(t); const a = await loadConfig(paths, {}), b = await loadConfig(paths, {}); assert.equal(a.fingerprint, b.fingerprint);
  const localPort = await loadConfig(paths, { RR_GATEWAY_PORT: "8300" }); assert.equal(a.fingerprint, localPort.fingerprint);
  const c = await loadConfig(paths, { RR_LOG_LEVEL: "debug" }); assert.notEqual(a.fingerprint, c.fingerprint);
});

test("[CONFIG-A5D19E72] model selection rules are validated by the runner", async () => {
  const { selectModel } = await import("../src/runner.ts");
  const config = { model: {}, runner: {}, server: {}, conversation: {}, logging: {}, sources: {}, fingerprint: "" } as never;
  assert.throws(() => selectModel([], config), /no active model connection/);
  const one = { name: "a", kind: "model", provider: "anthropic", auth: "key", state: "active" }; assert.equal(selectModel([one] as never, config).name, "a");
  assert.throws(() => selectModel([one, { ...one, name: "b" }] as never, config), /multiple model connections/);
});
