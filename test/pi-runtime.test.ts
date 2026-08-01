import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ensurePiRuntime,
  type PiPackageOperations,
} from "../src/pi-runtime.ts";
import { fixture } from "./helpers.ts";

function fakeOperations(version: string, calls: string[]): PiPackageOperations {
  return {
    latestVersion() {
      calls.push(`latest:${version}`);
      return version;
    },
    install(prefix, selected) {
      calls.push(`install:${selected}`);
      const root = join(
        prefix,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ version: selected }),
      );
    },
  };
}

test("[BOX-E1F472A1] the latest Pi version is installed once and then reused from deployment runtime state", async (t) => {
  const paths = await fixture(t),
    calls: string[] = [],
    operations = fakeOperations("1.2.3", calls);
  const first = await ensurePiRuntime(paths, operations),
    second = await ensurePiRuntime(paths, operations);
  assert.equal(first.version, "1.2.3");
  assert.equal(second.packageRoot, first.packageRoot);
  assert.deepEqual(calls, ["latest:1.2.3", "install:1.2.3", "latest:1.2.3"]);
});

test("[BOX-E1F472A1] registry failure reuses a valid cached Pi runtime with a warning", async (t) => {
  const paths = await fixture(t);
  await ensurePiRuntime(paths, fakeOperations("1.2.3", []));
  const cached = await ensurePiRuntime(paths, {
    latestVersion() {
      throw new Error("offline");
    },
    install() {
      assert.fail("cached runtime must not be reinstalled");
    },
  });
  assert.equal(cached.version, "1.2.3");
  assert.match(cached.warning!, /could not check.*cached Pi 1\.2\.3/i);
});

test("[BOX-E1F472A1] registry failure without a valid cached Pi runtime fails clearly", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    ensurePiRuntime(paths, {
      latestVersion() {
        throw new Error("offline");
      },
      install() {
        assert.fail("install is unreachable");
      },
    }),
    /no cached Pi runtime is available/,
  );
});
