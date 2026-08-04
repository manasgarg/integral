import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { get, type ClientRequest, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { saveConnection, validateConnection } from "../../src/connections.ts";
import { componentStatePath, readComponentState } from "../../src/state.ts";
import { fixture } from "../helpers.ts";
import { DurableQueue } from "../../src/queue.ts";

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

test("[SERVER-F886D80C] [SERVER-33E00BBA] [QUEUE-A19D6F43] [QUEUE-C84E1A70] [QUEUE-2F6B9D04] real CLI processes manage the queue and server lifecycle", async (t) => {
  if (process.platform === "win32") t.skip("POSIX signal acceptance test");
  const paths = await fixture(t),
    fakeBin = join(paths.root, "test-bin"),
    ports = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
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
scheduler_port = ${ports[3]}

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
  const durableQueue = new DurableQueue(paths.queue);
  await durableQueue.load();
  const queued = await durableQueue.enqueue("acceptance queued");

  const childEnv = {
    ...process.env,
    INTEGRAL_HOME: paths.root,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };

  const child = spawn(
    process.execPath,
    ["bin/integral.js", "server", "start"],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
          (["coordinator", "scheduler", "gateway", "runner"] as const).map(
            (component) => readComponentState(paths, component),
          ),
        )
      ).every((state) => state?.status === "ready"),
    () => `${stdout}\n${stderr}`,
  );
  const runQueue = (args: string[]) =>
    execFileSync(process.execPath, ["bin/integral.js", "queue", ...args], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
    });
  assert.match(
    runQueue(["ls"]),
    new RegExp(`queued\\t${queued.id}\\tacceptance queued`),
  );
  assert.equal(
    runQueue(["edit", queued.id, "revised", "text"]),
    `Edited ${queued.id}.\n`,
  );
  assert.deepEqual(JSON.parse(runQueue(["ls", "--json"])), [
    { ...queued, text: "revised text" },
  ]);
  assert.equal(runQueue(["delete", queued.id]), `Deleted ${queued.id}.\n`);
  assert.deepEqual(JSON.parse(runQueue(["ls", "--json"])), []);
  const stream = await new Promise<{
    request: ClientRequest;
    response: IncomingMessage;
  }>((resolve, reject) => {
    const request = get(
      `http://127.0.0.1:${ports[1]}/integral/events`,
      (response) => {
        response.once("data", () => resolve({ request, response }));
        response.once("error", reject);
      },
    );
    request.once("error", reject);
  });
  t.after(() => {
    stream.request.destroy();
    stream.response.destroy();
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  child.kill("SIGINT");
  let timeout: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    exited,
    new Promise<"timeout">(
      (resolve) => (timeout = setTimeout(() => resolve("timeout"), 5_000)),
    ),
  ]);
  clearTimeout(timeout);
  assert.notEqual(exit, "timeout", `${stdout}\n${stderr}`);
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  for (const component of [
    "coordinator",
    "scheduler",
    "gateway",
    "runner",
  ] as const)
    await assert.rejects(readFile(componentStatePath(paths, component)), {
      code: "ENOENT",
    });
});
