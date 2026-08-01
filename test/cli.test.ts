import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { main } from "../src/cli.ts";

async function capture(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "",
    stderr = "";
  const out = process.stdout.write,
    err = process.stderr.write;
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    return { code: await main(args), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

test("[CLI-6001FE46] top-level help lists the public command surface", async () => {
  const result = await capture(["--help"]);
  assert.equal(result.code, 0);
  for (const command of [
    "server",
    "talk",
    "queue",
    "connection",
    "config",
    "version",
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(result.stdout, /\bauth\b|\bcredential\b/);
});

test("[CLI-6001FE46] package metadata exposes only the Integral CLI", async () => {
  const packageJson: unknown = JSON.parse(
    await readFile("package.json", "utf8"),
  );
  assert.ok(packageJson && typeof packageJson === "object");
  assert.equal(Reflect.get(packageJson, "name"), "@pirogram/integral");
  assert.deepEqual(Reflect.get(packageJson, "bin"), {
    integral: "bin/integral.js",
  });
});

test("[CLI-04301CCA] version reports integral, Node, and Pi versions", async () => {
  const result = await capture(["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^integral 0\.1\.0/m);
  assert.match(result.stdout, /Node\.js 24\./);
  assert.match(result.stdout, /Pi runtime: latest \(resolved when needed\)/);
});
