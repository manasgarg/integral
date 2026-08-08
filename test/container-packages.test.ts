import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONTAINER_PACKAGES,
  loadContainerPackageState,
  planContainerPackageChange,
  saveContainerPackageState,
  validateContainerPackageNames,
} from "../src/container-packages.ts";
import { fixture } from "./helpers.ts";

test("[BOX-40521095] package policy validates names, revisions, installs, and upgrades", async (t) => {
  const paths = await fixture(t),
    initial = await loadContainerPackageState(paths);
  assert.deepEqual(initial, {
    revision: 0,
    packages: [...DEFAULT_CONTAINER_PACKAGES].sort(),
  });
  assert.throws(
    () => validateContainerPackageNames(["git; touch /host/escaped"]),
    /invalid Debian package name/,
  );
  const installed = planContainerPackageChange(
    initial,
    "install",
    validateContainerPackageNames(["jq", "curl", "jq"]),
    0,
  );
  assert.deepEqual(installed, {
    revision: 1,
    packages: ["ca-certificates", "curl", "gh", "git", "jq"],
  });
  assert.ok(installed);
  await saveContainerPackageState(paths, installed);
  assert.deepEqual(await loadContainerPackageState(paths), installed);
  assert.deepEqual(
    planContainerPackageChange(installed, "upgrade", ["jq"], 1),
    { revision: 2, packages: installed.packages },
  );
  assert.throws(
    () => planContainerPackageChange(installed, "upgrade", ["ripgrep"], 1),
    /not installed: ripgrep/,
  );
  assert.throws(
    () => planContainerPackageChange(installed, "install", ["ripgrep"], 0),
    /revision conflict/,
  );
});
