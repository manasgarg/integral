import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const behaviorFiles = (await readdir("behavior")).filter(
  (name) => name.endsWith(".md") && name !== "README.md",
);
const testFiles = (await readdir("test")).filter((name) =>
  name.endsWith(".test.ts"),
);
const testSources = await Promise.all(
    testFiles.map(async (name) => ({
      name,
      text: await readFile(join("test", name), "utf8"),
    })),
  ),
  tests = testSources.map(({ text }) => text).join("\n"),
  missing: string[] = [],
  sourceInspection = testSources
    .filter(({ text }) =>
      /(?:readFile|readFileSync)\s*\(\s*["'`]src\//.test(text),
    )
    .map(({ name }) => name);
let behaviorCount = 0,
  scenarioCount = 0;

for (const name of behaviorFiles) {
  const text = await readFile(join("behavior", name), "utf8");
  scenarioCount += [...text.matchAll(/^\tWhen /gm)].length;
  for (const match of text.matchAll(/^## ([A-Z]+-[0-9A-F]{8}) —/gm)) {
    behaviorCount++;
    const id = match[1]!;
    const automated = tests.includes(`[${id}]`);
    const noted = text.includes(`Automation note (${id}):`);
    if (!automated && !noted) missing.push(id);
  }
}

if (sourceInspection.length > 0) {
  process.stderr.write(
    `Tests must exercise behavior instead of inspecting implementation source:\n${sourceInspection.join("\n")}\n`,
  );
  process.exitCode = 1;
}

if (missing.length > 0) {
  process.stderr.write(
    `Behaviors without tests or automation notes:\n${missing.join("\n")}\n`,
  );
  process.exitCode = 1;
}

if (!process.exitCode)
  process.stdout.write(
    `Behavior inventory: ${behaviorCount} behavior IDs are traced across ${scenarioCount} When paths.\n`,
  );
