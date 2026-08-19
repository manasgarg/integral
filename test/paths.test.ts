import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsFor, resolveIntegralHome } from "../src/paths.ts";

/* @covers ENV-2A7C4E91
Given `INTEGRAL_HOME` contains an absolute path
	When an integral command needs deployment state
		Then integral uses that path as the deployment root
			And keeps configuration under `<INTEGRAL_HOME>/config`
			And keeps durable data under `<INTEGRAL_HOME>/data`
			And keeps reconstructible runtime state under `<INTEGRAL_HOME>/state`
*/
test("[ENV-2A7C4E91] INTEGRAL_HOME selects config, data, and state roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "integral-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveIntegralHome({ INTEGRAL_HOME: root }), root);
  const paths = pathsFor(root);
  assert.equal(paths.config, join(root, "config"));
  assert.equal(paths.data, join(root, "data"));
  assert.equal(paths.state, join(root, "state"));
  assert.equal(paths.runs, join(root, "data", "runs"));
  assert.equal(paths.runViews, join(root, "state", "run-views"));
});

/* @covers ENV-8D13B6F0
Given `INTEGRAL_HOME` is unset or empty
	And `HOME` contains an absolute path
	When an integral command needs deployment state
		Then integral uses `<HOME>/.integral` as the deployment root
			And behaves as if that absolute path had been supplied through `INTEGRAL_HOME`
*/
test("[ENV-8D13B6F0] HOME supplies the default .integral deployment", () => {
  assert.equal(
    resolveIntegralHome({ HOME: "/tmp/operator" }),
    "/tmp/operator/.integral",
  );
});

/* @covers ENV-4C9E20A7
Given an integral command needs deployment state
	When `INTEGRAL_HOME` is set to a relative path
		Then integral exits non-zero before reading or writing deployment state
			And explains that `INTEGRAL_HOME` must be absolute
	When both `INTEGRAL_HOME` and `HOME` are unavailable
		Then integral exits non-zero before reading or writing deployment state
			And explains how to set `INTEGRAL_HOME`
*/
test("[ENV-4C9E20A7] invalid deployment homes fail clearly", () => {
  assert.throws(
    () => resolveIntegralHome({ INTEGRAL_HOME: "relative" }),
    /must be an absolute path/,
  );
  assert.throws(() => resolveIntegralHome({}), /set INTEGRAL_HOME/);
});

/* @covers ENV-B71F3D85
Given two integral processes receive paths that resolve to the same deployment root
	When they resolve their deployment identity
		Then they use the same normalized absolute root
			And contend for the same per-component locks
			And resolve the same durable conversation registry and per-conversation queues
*/
test("[ENV-B71F3D85] equivalent deployment paths normalize identically", () => {
  assert.equal(
    resolveIntegralHome({ INTEGRAL_HOME: "/tmp/a/../integral" }),
    "/tmp/integral",
  );
});
