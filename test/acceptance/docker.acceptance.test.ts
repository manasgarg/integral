import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildContainerSpec,
  createLockedNetwork,
  dockerNetworkGateway,
  dockerRunArgs,
  ensureContainerImage,
  newSessionIdentity,
} from "../../src/container.ts";
import { loadConfig } from "../../src/config.ts";
import { validateConnection } from "../../src/connections.ts";
import { deploymentId } from "../../src/state.ts";
import { fixture } from "../helpers.ts";

test("[BOX-601613D4] [GATEWAY-EC79406A] live Pi container enforces the declared identity, mounts, resources, and internal network", async (t) => {
  assert.doesNotThrow(
    () => execFileSync("docker", ["info"], { stdio: "ignore" }),
    "Docker acceptance requires a reachable Docker daemon",
  );
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    network = `rr-acceptance-${deploymentId(paths)}`,
    sessionHome = join(paths.root, "session"),
    caCert = join(paths.root, "ca.pem"),
    caBundle = join(paths.root, "bundle.pem");
  await mkdir(sessionHome, { recursive: true });
  await writeFile(caCert, "acceptance CA fixture\n");
  await writeFile(caBundle, "acceptance CA fixture\n");
  ensureContainerImage(config);
  await createLockedNetwork(network);
  const identity = newSessionIdentity(),
    spec = buildContainerSpec({
      config,
      gatewayUrl: "http://host.rr.internal:7300",
      gatewayAddress: dockerNetworkGateway(network),
      caCert,
      caBundle,
      sessionHome,
      ...identity,
      model: validateConnection({
        name: "acceptance-model",
        kind: "model",
        provider: "anthropic",
        auth: "key",
      }),
      mcp: [],
    }),
    name = `rr-${identity.sessionId}`,
    runArgs = dockerRunArgs(spec, config, network),
    imageIndex = runArgs.indexOf(spec.image),
    createArgs = runArgs
      .slice(0, imageIndex + 1)
      .filter((argument) => argument !== "--rm");
  createArgs[0] = "create";
  createArgs.push("node", "-e", "setInterval(() => undefined, 60_000)");
  t.after(() => {
    try {
      execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
    } catch {
      /* container did not reach creation */
    }
    try {
      execFileSync("docker", ["network", "rm", network], {
        stdio: "ignore",
      });
    } catch {
      /* network did not reach creation */
    }
  });
  execFileSync("docker", createArgs, { stdio: "ignore" });
  execFileSync("docker", ["start", name], { stdio: "ignore" });
  const inspection = JSON.parse(
    execFileSync("docker", ["inspect", name], {
      encoding: "utf8",
    }),
  )[0] as {
    Config: { User: string; Env: string[] };
    HostConfig: {
      ReadonlyRootfs: boolean;
      CapDrop: string[];
      Memory: number;
      NetworkMode: string;
      Tmpfs: Record<string, string>;
      SecurityOpt: string[];
    };
    Mounts: { Source: string; Destination: string; RW: boolean }[];
  };
  assert.equal(inspection.Config.User, "1000:1000");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.equal(
    inspection.HostConfig.Memory,
    config.runner.memoryMb * 1024 ** 2,
  );
  assert.equal(inspection.HostConfig.NetworkMode, network);
  assert.match(inspection.HostConfig.Tmpfs["/tmp"] ?? "", /noexec/);
  assert.ok(
    inspection.HostConfig.SecurityOpt.some((value) =>
      value.includes("no-new-privileges"),
    ),
  );
  assert.doesNotMatch(inspection.Config.Env.join("\n"), /acceptance-secret/);
  assert.equal(
    inspection.Mounts.some((mount) => mount.Source === process.cwd()),
    false,
  );
  assert.doesNotThrow(
    () =>
      execFileSync(
        "docker",
        [
          "exec",
          name,
          "node",
          "-e",
          `for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[key]; fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1000) }).then(() => process.exit(1), () => process.exit(0));`,
        ],
        { stdio: "ignore", timeout: 5_000 },
      ),
    "an internal-network container must not have a direct route to the internet",
  );
});
