import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditBehaviorCoverage } from "../scripts/check-behavior-coverage.ts";

test("behavior coverage recursively validates executable tags and automation exceptions", async () => {
  const audit = await auditBehaviorCoverage();
  assert.deepEqual(audit.errors, []);
  assert.ok(audit.behaviorCount > 0);
  assert.ok(audit.scenarioCount >= audit.behaviorCount);
  assert.ok(audit.clauseCount >= audit.scenarioCount);
  assert.ok(audit.coveredClauseCount > 0);
});

test("behavior coverage matches exact clause text in recursively discovered tests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "integral-behavior-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "behavior"));
  await mkdir(join(root, "test", "acceptance"), { recursive: true });
  await writeFile(
    join(root, "behavior", "sample.md"),
    `# Sample\n\n## SAMPLE-1234ABCD — Do something\n\nGiven a stable precondition\n\tWhen the action occurs\n\t\tThen the result is visible\n\t\t\tAnd unrelated state is preserved\n`,
  );
  const testFile = join(root, "test", "acceptance", "sample.test.ts");
  await writeFile(
    testFile,
    `/* @covers SAMPLE-1234ABCD\nGiven a stable precondition\n\tWhen the action occurs\n\t\tThen the result is visible\n\t\t\tAnd unrelated state is preserved\n*/\ntest("[SAMPLE-1234ABCD] sample", () => {});\n`,
  );
  assert.deepEqual((await auditBehaviorCoverage(root)).errors, []);

  await writeFile(
    testFile,
    `/* @covers SAMPLE-1234ABCD\nGiven a stable precondition\n\tWhen the action occurs\n\t\tThen a stale result is visible\n*/\ntest("[SAMPLE-1234ABCD] sample", () => {});\n`,
  );
  const stale = await auditBehaviorCoverage(root);
  assert.ok(
    stale.errors.some((error) =>
      error.includes("does not match the behavior clause text"),
    ),
  );
  assert.ok(stale.errors.some((error) => error.includes("uncovered clause")));
});
