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

/* @covers BOX-40521095
Given Pi runs in an immutable managed image without host Docker access
	When Pi lists the image's Debian packages through Integral's authenticated control pathway
		Then Integral returns the durable desired package set and its revision
			And includes the base packages required by the managed image
	When Pi requests installation of valid Debian package names at the current revision
		Then Integral builds a replacement image from the selected exact Pi version
			And obtains packages only through the base image's configured APT repositories
			And records the new desired package set and immutable image identity
			And replaces the current container after the active turn completes
	When Pi requests an upgrade of desired packages at the current revision
		Then Integral rebuilds the replacement image without cached package layers
			And records a new revision and immutable image identity
	When Pi submits command syntax, an unknown package for upgrade, or a stale revision
		Then Integral rejects the request without changing package state or the selected image
	When the active Dockerfile declares Pi with a floating version such as `latest`
		And a human approves a fresh rebuild of that recipe
		Then Integral resolves Pi again during the build instead of overriding the Dockerfile with the prior selected version
			And records the version and immutable image identity that were actually installed
*/
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
