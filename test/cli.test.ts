import assert from "node:assert/strict";
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
  for (const command of ["server", "talk", "connection", "config", "version"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(result.stdout, /\bauth\b|\bcredential\b/);
});

test("[CLI-04301CCA] version reports rr, Node, and Pi versions", async () => {
  const result = await capture(["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^rr 0\.1\.0/m);
  assert.match(result.stdout, /Node\.js 24\./);
  assert.match(result.stdout, /Pi 0\.80\.3/);
});
