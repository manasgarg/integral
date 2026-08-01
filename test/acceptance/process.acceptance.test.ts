import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { saveConnection, validateConnection } from "../../src/connections.ts";
import { componentStatePath, readComponentState } from "../../src/state.ts";
import { fixture } from "../helpers.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for server readiness\n${diagnostics()}`);
}

test("[SERVER-F886D80C] [SERVER-33E00BBA] real CLI process becomes ready and cleans owned deployment state after SIGTERM", async (t) => {
  if (process.platform === "win32") t.skip("POSIX signal acceptance test");
  const paths = await fixture(t),
    fakeBin = join(paths.root, "test-bin"),
    ports = await Promise.all([freePort(), freePort(), freePort()]);
  await mkdir(fakeBin, { recursive: true });
  const docker = join(fakeBin, "docker");
  await writeFile(
    docker,
    `#!/bin/sh
if [ "$1" = "network" ] && [ "$2" = "inspect" ] && [ "$3" = "--format" ]; then
  echo 127.0.0.1
fi
exit 0
`,
  );
  await chmod(docker, 0o755);
  await mkdir(join(paths.root, "config"), { recursive: true });
  await writeFile(
    paths.mainConfig,
    `[server]
gateway_port = ${ports[0]}
coordinator_port = ${ports[1]}
runner_port = ${ports[2]}

[logging]
level = "error"
`,
  );
  await saveConnection(
    paths,
    validateConnection({
      name: "acceptance-model",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    }),
    "acceptance-secret",
  );

  const child = spawn(process.execPath, ["bin/rr.js", "server", "start"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RR_HOME: paths.root,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitUntil(
    async () =>
      (
        await Promise.all(
          (["coordinator", "gateway", "runner"] as const).map((component) =>
            readComponentState(paths, component),
          ),
        )
      ).every((state) => state?.status === "ready"),
    () => `${stdout}\n${stderr}`,
  );
  child.kill("SIGTERM");
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  for (const component of ["coordinator", "gateway", "runner"] as const)
    await assert.rejects(readFile(componentStatePath(paths, component)), {
      code: "ENOENT",
    });
});
