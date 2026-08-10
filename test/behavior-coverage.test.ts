import assert from "node:assert/strict";
import test from "node:test";
import { auditBehaviorCoverage } from "../scripts/check-behavior-coverage.ts";

test("behavior coverage recursively validates executable tags and automation exceptions", async () => {
  const audit = await auditBehaviorCoverage();
  assert.deepEqual(audit.errors, []);
  assert.ok(audit.behaviorCount > 0);
  assert.ok(audit.scenarioCount >= audit.behaviorCount);
});
