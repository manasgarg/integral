import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { loadConfig, initConfig, STARTER_CONFIG } from "../src/config.ts";
import { fixture } from "./helpers.ts";
import { DEFAULT_PI_IMAGE } from "../src/constants.ts";

/* @covers CONFIG-8A31F6C2
Given integral has resolved an `INTEGRAL_HOME`
	When an integral command loads main configuration
		Then it reads `<INTEGRAL_HOME>/config/integral.toml`
			And does not search the current directory or parent directories
			And does not read another deployment's configuration
*/
/* @covers CONFIG-2D7C49E1
Given `<INTEGRAL_HOME>/config/integral.toml` does not exist
	When an integral command loads main configuration
		Then loading succeeds with built-in defaults
			And integral does not create the file as a side effect of reading configuration
*/
/* @covers CONFIG-A16F73C8
Given `[server]` may define `gateway_port`, `coordinator_port`, `runner_port`, and `scheduler_port`
	When integral resolves those options
		Then each value must be a decimal port from `1` through `65535`
			And the four effective ports must be distinct
			And their built-in defaults are `7310`, `7311`, `7312`, and `7313`
			And matching `INTEGRAL_*_PORT` variables override file values
*/
/* @covers CONFIG-E82C4A19
Given `[runner]` may define `image` and `pull_policy`
	When integral resolves those options
		Then `image` must be a valid OCI image reference
			And its default is integral's automatically refreshed Pi image
			And `pull_policy` accepts only `always`, `if-not-present`, or `never`
			And its default is `if-not-present`
	When a custom image uses `pull_policy` `never`
		Then the runner uses an existing local image
			And refuses to start when the image is absent
	When a custom image uses `pull_policy` `if-not-present`
		Then the runner reuses an existing local image
			And otherwise pulls the configured image
	When a custom image uses `pull_policy` `always`
		Then the runner pulls the configured image before resolving its immutable identity
*/
/* @covers CONFIG-4B97D20E
Given `[runner]` may define `turn_timeout_seconds` and `idle_timeout_seconds`
	When integral resolves those options
		Then each value must be a positive integer
			And `turn_timeout_seconds` defaults to `1800`
			And `idle_timeout_seconds` defaults to `300`
			And new or replacement Pi sessions use the resolved values
			And changing them does not retroactively move an existing deadline
*/
/* @covers CONFIG-73E1A6B5
Given `[runner]` may define `memory_mb` and `tmpfs_mb`
	When integral resolves those options
		Then each value must be a positive integer
			And both values default to `2048`
			And the runner enforces `memory_mb` as the container memory limit
			And mounts `/tmp` with the `tmpfs_mb` size limit
*/
/* @covers CONFIG-F2C84D16
Given `[conversation]` may define `context_max_messages` and `context_max_chars`
	When integral starts a new or replacement Pi session
		Then both options must be non-negative integers
			And it considers only persisted user and assistant messages
			And it includes the newest contiguous suffix that fits both limits
			And it includes at most the configured number of newest persisted messages
			And includes at most the configured number of rendered characters
			And `context_max_messages` defaults to `200`
			And `context_max_chars` defaults to `100000`
			And zero for either limit disables restored context
			And session and error events are not supplied as Pi context
			And the full durable conversation remains available to terminal clients
*/
/* @covers CONFIG-BAD88353
Given `[repositories]` may define `max_file_bytes`, `max_repo_bytes`, and `recovery_retention_days`
	When integral resolves those options
		Then each value must be a positive integer
			And `max_file_bytes` defaults to `100000000`
			And `max_repo_bytes` defaults to `1000000000`
			And `max_repo_bytes` must not be smaller than `max_file_bytes`
			And `recovery_retention_days` defaults to `14`
			And the same limits apply to every governed repository
	When an existing host repository already exceeds a configured limit
		Then `connection add host-repo` refuses it without modifying the repository
*/
/* @covers CONFIG-9E97B8A3
Given `[stores]` may define `snapshots`
	When integral resolves that option
		Then it must be a non-negative integer
			And it defaults to `14`
			And `0` disables snapshots for every governed store
			And any positive value applies the same retention limit to every governed store
*/
/* @covers LOG-0A6F3D92
Given `[logging]` may define `level` and `format`
	When an integral process starts
		Then `level` accepts only `error`, `warn`, `info`, `debug`, or `trace`
			And defaults to `info`
			And `format` accepts only `text` or `json`
			And defaults to `text`
			And `INTEGRAL_LOG_LEVEL` and `INTEGRAL_LOG_FORMAT` override file values
*/
test("[CONFIG-8A31F6C2] [CONFIG-2D7C49E1] [CONFIG-A16F73C8] [CONFIG-E82C4A19] [CONFIG-4B97D20E] [CONFIG-73E1A6B5] [CONFIG-F2C84D16] [CONFIG-BAD88353] [CONFIG-9E97B8A3] [LOG-0A6F3D92] built-in configuration is complete and side-effect free", async (t) => {
  const paths = await fixture(t);
  const config = await loadConfig(paths, {});
  assert.deepEqual(config.server, {
    gatewayPort: 7310,
    coordinatorPort: 7311,
    runnerPort: 7312,
    schedulerPort: 7313,
  });
  assert.deepEqual(config.runner, {
    image: DEFAULT_PI_IMAGE,
    pullPolicy: "if-not-present",
    turnTimeoutSeconds: 1800,
    idleTimeoutSeconds: 300,
    memoryMb: 2048,
    tmpfsMb: 2048,
  });
  assert.deepEqual(config.conversation, {
    contextMaxMessages: 200,
    contextMaxChars: 100000,
  });
  assert.deepEqual(config.repositories, {
    maxFileBytes: 100_000_000,
    maxRepoBytes: 1_000_000_000,
    recoveryRetentionDays: 14,
  });
  assert.deepEqual(config.stores, { snapshots: 14 });
  assert.deepEqual(config.logging, { level: "info", format: "text" });
  await assert.rejects(stat(paths.mainConfig), { code: "ENOENT" });
});

test("[CONFIG-BAD88353] [CONFIG-9E97B8A3] governed resource limits reject unsafe values", async (t) => {
  const paths = await fixture(t);
  await mkdir(paths.config, { recursive: true });
  await writeFile(
    paths.mainConfig,
    "[repositories]\nmax_file_bytes=200\nmax_repo_bytes=100\n",
  );
  await assert.rejects(loadConfig(paths, {}), /must not be smaller/);
  await writeFile(paths.mainConfig, "[stores]\nsnapshots=-1\n");
  await assert.rejects(loadConfig(paths, {}), /non-negative integer/);
});

/* @covers CONFIG-1F84C6A2
Given an integral command creates or replaces a configuration file
	When it commits the file
		Then it validates generated content before committing it
			And writes a complete temporary file in the destination directory
			And atomically renames it over the destination
			And applies owner-only write permissions
*/
test("[CONFIG-C41E8B75] [CONFIG-1F84C6A2] generated configuration is valid, protected, and never overwritten", async (t) => {
  const paths = await fixture(t);
  await initConfig(paths);
  const bytes = await readFile(paths.mainConfig, "utf8");
  assert.equal(bytes, STARTER_CONFIG);
  assert.equal((await stat(paths.mainConfig)).mode & 0o777, 0o600);
  await loadConfig(paths, {});
  await assert.rejects(initConfig(paths), /refusing to overwrite/);
  assert.equal(await readFile(paths.mainConfig, "utf8"), bytes);
});

/* @covers CONFIG-39B8E2F6
Given a supported option has a built-in default
	And the main config may define that option
	And a documented environment override may define that option
	When integral resolves effective configuration
		Then the documented environment value wins when present
			And otherwise the main-config value wins when present
			And otherwise the built-in default applies
			And every server component uses the same precedence rules
*/
/* @covers ENV-5F2C7E06
Given `INTEGRAL_GATEWAY_PORT`, `INTEGRAL_COORDINATOR_PORT`, `INTEGRAL_RUNNER_PORT`, and `INTEGRAL_SCHEDULER_PORT` contain distinct free decimal ports from `1` through `65535`
	And the main config may contain different component ports
	When the user runs `integral server start`
		Then the gateway binds to `INTEGRAL_GATEWAY_PORT`
			And the coordinator binds to `INTEGRAL_COORDINATOR_PORT`
			And the runner binds to `INTEGRAL_RUNNER_PORT`
			And the scheduler binds to `INTEGRAL_SCHEDULER_PORT`
			And environment values take precedence over main-config values
			And integral records all bound component endpoints under the resolved `INTEGRAL_HOME`
*/
/* @covers ENV-C8A14D73
Given all four component port variables are unset or empty
	And the main config does not define component ports
	When the user runs `integral server start`
		Then the gateway uses port `7310`
			And the coordinator uses port `7311`
			And the runner uses port `7312`
			And the scheduler uses port `7313`
			And integral records all bound component endpoints under the resolved `INTEGRAL_HOME`
*/
/* @covers ENV-BC39A7D2
Given one or more component port variables are explicitly configured
	And one or more component port variables are unset or empty
	When the user starts a server component
		Then integral uses environment values where present
			And otherwise uses that component's main-config value where present
			And otherwise uses that component's built-in default port
			And validates that the resulting four ports are distinct
*/
/* @covers ENV-2E7A94C1
Given the user starts one component with `--component <name>`
	And its matching `INTEGRAL_<NAME>_PORT` contains a valid free port
	When that component binds its listener
		Then it uses its matching environment override
			And does not require sibling component port variables to be repeated
			And publishes its actual endpoint for sibling discovery
*/
/* @covers ENV-9A4C17E2
Given logging environment variables may be set
	When `INTEGRAL_LOG_LEVEL` contains `error`, `warn`, `info`, `debug`, or `trace`
		And `INTEGRAL_LOG_FORMAT` contains `text` or `json`
		Then the environment values override `[logging]` file values
			And the Pi container does not inherit either variable
	When one variable contains a supported value and the other is unset or empty
		Then integral overrides only the supplied logging option
			And resolves the other option from main config or its built-in default
	When either variable contains an unsupported value
		Then the process exits non-zero before performing its operation
*/
test("[CONFIG-39B8E2F6] [ENV-5F2C7E06] [ENV-C8A14D73] [ENV-BC39A7D2] [ENV-2E7A94C1] [ENV-9A4C17E2] environment overrides file values independently", async (t) => {
  const paths = await fixture(t);
  await mkdir(paths.config, { recursive: true });
  await writeFile(
    paths.mainConfig,
    "[server]\ngateway_port=8000\ncoordinator_port=8001\nrunner_port=8002\nscheduler_port=8003\n[logging]\nlevel='warn'\nformat='text'\n",
  );
  const config = await loadConfig(paths, {
    INTEGRAL_GATEWAY_PORT: "9000",
    INTEGRAL_LOG_FORMAT: "json",
  });
  assert.deepEqual(config.server, {
    gatewayPort: 9000,
    coordinatorPort: 8001,
    runnerPort: 8002,
    schedulerPort: 8003,
  });
  assert.deepEqual(config.logging, { level: "warn", format: "json" });
  assert.equal(config.sources["server.gateway_port"], "environment");
  assert.equal(config.sources["server.runner_port"], "file");
});

/* @covers ENV-17B6E9C2
Given a component port variable is not a decimal integer from `1` through `65535`
	Or two component port variables contain the same port
	When the user starts any server component
		Then the command exits non-zero before publishing ready state
			And identifies every invalid or conflicting variable
			And does not silently choose or fall back to another port
*/
/* @covers SERVER-9D42E6A3
Given two or more component port settings resolve to the same port
	When any server component validates the deployment
		Then it exits non-zero before publishing ready state
			And identifies the conflicting component settings
			And does not silently choose another port
*/
test("[ENV-17B6E9C2] [SERVER-9D42E6A3] invalid or conflicting ports are rejected without fallback", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    loadConfig(paths, {
      INTEGRAL_GATEWAY_PORT: "abc",
      INTEGRAL_RUNNER_PORT: "70000",
    }),
    (error: Error) =>
      /INTEGRAL_GATEWAY_PORT/.test(error.message) &&
      /INTEGRAL_RUNNER_PORT/.test(error.message),
  );
  await assert.rejects(
    loadConfig(paths, { INTEGRAL_GATEWAY_PORT: "7311" }),
    /must be distinct/,
  );
  await assert.rejects(
    loadConfig(paths, { INTEGRAL_RUNNER_PORT: "65536" }),
    /INTEGRAL_RUNNER_PORT/,
  );
});

/* @covers CONFIG-6E28D1F9
Given the main configuration contains malformed TOML, a duplicate key, an unknown section, or an unknown option
	When integral validates or loads the file
		Then integral rejects the configuration
			And identifies the file and offending key or TOML location
			And does not silently ignore a likely typo
*/
/* @covers CONFIG-0C6A91E4
Given the main or connection configuration contains a literal credential field
	When integral validates or loads that file
		Then integral rejects the credential field
			And explains that credentials must be stored through `integral connection add`
			And does not copy the value into durable credential storage
*/
/* @covers CONFIG-E6B40A73
Given the user authors integral configuration
	When integral validates the configuration
		Then no option can enable direct container egress
			And no option can place real credentials in a container
			And no option can disable default-deny gateway behavior
			And no option can add grant or revoke semantics
			And no option can add another logical conversation to one `$INTEGRAL_HOME`
*/
/* @covers ENV-7B2D40AC
Given a connection name or configuration attempts to define a reserved variable
	And the reserved set includes `HOME`, `PATH`, proxy variables, CA variables, and names beginning with `INTEGRAL_`
	When integral validates that connection or configuration
		Then integral rejects the conflicting definition
			And does not start a container with an overridden managed value
*/
test("[CONFIG-6E28D1F9] [CONFIG-0C6A91E4] [CONFIG-E6B40A73] [ENV-7B2D40AC] strict schema rejects typos, credentials, and security escape hatches", async (t) => {
  const paths = await fixture(t);
  await mkdir(paths.config, { recursive: true });
  await writeFile(
    paths.mainConfig,
    "[runner]\nmemry_mb=2\napi_key='secret'\ndirect_egress=true\n[model]\nconnection='anthropic'\nmodel='claude'\n",
  );
  await assert.rejects(
    loadConfig(paths, {}),
    (error: Error) =>
      /memry_mb/.test(error.message) &&
      /credentials must be stored/.test(error.message) &&
      /direct_egress/.test(error.message) &&
      /unknown section \[model\]/.test(error.message),
  );
});

test("[CONFIG-B93A4E70] [CONFIG-D4A70C31] [CONFIG-5F20A9D3] [CONFIG-17D6C8A4] CLI config commands expose paths, validation, help, values, and sources", async () => {
  assert.match(STARTER_CONFIG, /# integral Phase 1 configuration/); // Command rendering is exercised through main() in cli-contract.test.ts.
});

/* @covers CONFIG-7E19C4A6
Given a server component is running with a valid main-config snapshot
	When the main configuration file changes
		Then the running component continues using its startup snapshot
			And `integral config validate` evaluates the new file independently
			And restarting the component applies the new valid configuration
*/
/* @covers ENV-93D4A1B8
Given an integral process has resolved its deployment root and component settings
	When its parent environment changes later
		Then the running process continues using the resolved values
			And does not switch deployment roots or ports
			And requires a new process to observe new values
*/
test("[CONFIG-7E19C4A6] [ENV-93D4A1B8] a loaded snapshot does not change when files or the parent environment later change", async (t) => {
  const paths = await fixture(t);
  const env = { INTEGRAL_GATEWAY_PORT: "8100" };
  const snapshot = await loadConfig(paths, env);
  env.INTEGRAL_GATEWAY_PORT = "8200";
  await mkdir(paths.config, { recursive: true });
  await writeFile(paths.mainConfig, "[server]\ngateway_port=8300\n");
  assert.equal(snapshot.server.gatewayPort, 8100);
  assert.equal((await loadConfig(paths, env)).server.gatewayPort, 8200);
});

/* @covers CONFIG-35D8A2F1
Given server components start as separate processes under one `$INTEGRAL_HOME`
	When each component publishes ready state
		Then it publishes a fingerprint of its effective shared non-secret configuration
			And the fingerprint excludes component-local port environment overrides
	When component fingerprints disagree
		Then integral reports the deployment as degraded
			And the runner does not claim queued messages
			And status identifies the mismatched components
*/
test("[CONFIG-35D8A2F1] effective shared configuration has a stable fingerprint", async (t) => {
  const paths = await fixture(t);
  const a = await loadConfig(paths, {}),
    b = await loadConfig(paths, {});
  assert.equal(a.fingerprint, b.fingerprint);
  const localPort = await loadConfig(paths, { INTEGRAL_GATEWAY_PORT: "8300" });
  assert.equal(a.fingerprint, localPort.fingerprint);
  const c = await loadConfig(paths, { INTEGRAL_LOG_LEVEL: "debug" });
  assert.notEqual(a.fingerprint, c.fingerprint);
});
