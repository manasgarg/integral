import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsFor, resolveRrHome } from "../src/paths.ts";

test("[ENV-2A7C4E91] RR_HOME selects config, data, and state roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rr-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveRrHome({ RR_HOME: root }), root);
  const paths = pathsFor(root);
  assert.equal(paths.config, join(root, "config"));
  assert.equal(paths.data, join(root, "data"));
  assert.equal(paths.state, join(root, "state"));
});

test("[ENV-8D13B6F0] HOME supplies the default .rr deployment", () => {
  assert.equal(resolveRrHome({ HOME: "/tmp/operator" }), "/tmp/operator/.rr");
});

test("[ENV-4C9E20A7] invalid deployment homes fail clearly", () => {
  assert.throws(() => resolveRrHome({ RR_HOME: "relative" }), /must be an absolute path/);
  assert.throws(() => resolveRrHome({}), /set RR_HOME/);
});

test("[ENV-B71F3D85] equivalent deployment paths normalize identically", () => {
  assert.equal(resolveRrHome({ RR_HOME: "/tmp/a/../rr" }), "/tmp/rr");
});
