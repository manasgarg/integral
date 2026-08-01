import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const behaviorFiles = (await readdir("behavior")).filter((name) => name.endsWith(".md") && name !== "README.md");
const testFiles = (await readdir("test")).filter((name) => name.endsWith(".test.ts"));
const tests = (await Promise.all(testFiles.map((name) => readFile(join("test", name), "utf8")))).join("\n");
const missing: string[] = [];

for (const name of behaviorFiles) {
  const text = await readFile(join("behavior", name), "utf8");
  for (const match of text.matchAll(/^## ([A-Z]+-[0-9A-F]{8}) —/gm)) {
    const id = match[1]!;
    const automated = tests.includes(`[${id}]`);
    const noted = text.includes(`Automation note (${id}):`);
    if (!automated && !noted) missing.push(id);
  }
}

if (missing.length > 0) {
  process.stderr.write(`Behaviors without tests or automation notes:\n${missing.join("\n")}\n`);
  process.exitCode = 1;
}
