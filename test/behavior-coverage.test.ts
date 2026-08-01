import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

test("behavior inventory requires an explicitly tagged automated test or an automation note", async () => {
  const behaviorFiles = (await readdir("behavior")).filter(
      (name) => name.endsWith(".md") && name !== "README.md",
    ),
    testFiles = (await readdir("test")).filter((name) =>
      name.endsWith(".test.ts"),
    );
  const sources = await Promise.all(
      testFiles.map(async (name) => ({
        name,
        text: await readFile(join("test", name), "utf8"),
      })),
    ),
    tests = sources.map(({ text }) => text).join("\n");
  assert.deepEqual(
    sources
      .filter(({ text }) =>
        /(?:readFile|readFileSync)\s*\(\s*["'`]src\//.test(text),
      )
      .map(({ name }) => name),
    [],
    "behavior tests must not inspect implementation source",
  );
  const missing: string[] = [];
  for (const name of behaviorFiles) {
    const text = await readFile(join("behavior", name), "utf8");
    for (const match of text.matchAll(/^## ([A-Z]+-[0-9A-F]{8}) —/gm)) {
      const id = match[1]!;
      if (
        !tests.includes(`[${id}]`) &&
        !text.includes(`Automation note (${id}):`)
      )
        missing.push(id);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `behaviors without coverage: ${missing.join(", ")}`,
  );
});
