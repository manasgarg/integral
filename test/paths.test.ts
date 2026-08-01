import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsFor, resolveIntegralHome } from "../src/paths.ts";

test("[ENV-2A7C4E91] INTEGRAL_HOME selects config, data, and state roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "integral-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveIntegralHome({ INTEGRAL_HOME: root }), root);
  const paths = pathsFor(root);
  assert.equal(paths.config, join(root, "config"));
  assert.equal(paths.data, join(root, "data"));
  assert.equal(paths.state, join(root, "state"));
});

test("[ENV-8D13B6F0] HOME supplies the default .integral deployment", () => {
  assert.equal(
    resolveIntegralHome({ HOME: "/tmp/operator" }),
    "/tmp/operator/.integral",
  );
});

test("[ENV-4C9E20A7] invalid deployment homes fail clearly", () => {
  assert.throws(
    () => resolveIntegralHome({ INTEGRAL_HOME: "relative" }),
    /must be an absolute path/,
  );
  assert.throws(() => resolveIntegralHome({}), /set INTEGRAL_HOME/);
});

test("[ENV-B71F3D85] equivalent deployment paths normalize identically", () => {
  assert.equal(
    resolveIntegralHome({ INTEGRAL_HOME: "/tmp/a/../integral" }),
    "/tmp/integral",
  );
});
