import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const behaviorIdPattern = /^[A-Z]+-[0-9A-F]{8}$/;

interface SourceFile {
  name: string;
  text: string;
}

export interface BehaviorCoverageAudit {
  behaviorCount: number;
  scenarioCount: number;
  errors: string[];
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? await filesBelow(path) : [path];
    }),
  );
  return nested.flat().sort();
}

async function sources(files: string[]): Promise<SourceFile[]> {
  return await Promise.all(
    files.map(async (name) => ({ name, text: await readFile(name, "utf8") })),
  );
}

function testTitles(source: string): string[] {
  return [
    ...source.matchAll(
      /\b(?:test|it)\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

export async function auditBehaviorCoverage(
  root = ".",
): Promise<BehaviorCoverageAudit> {
  const behaviorSources = await sources(
      (await filesBelow(join(root, "behavior"))).filter(
        (name) => name.endsWith(".md") && !name.endsWith("README.md"),
      ),
    ),
    testSources = await sources(
      (await filesBelow(join(root, "test"))).filter((name) =>
        name.endsWith(".test.ts"),
      ),
    ),
    ids = new Set<string>(),
    automated = new Set<string>(),
    noted = new Set<string>(),
    errors: string[] = [];
  let scenarioCount = 0;

  for (const source of behaviorSources) {
    scenarioCount += [...source.text.matchAll(/^\tWhen /gm)].length;
    for (const match of source.text.matchAll(/^## ([A-Z]+-[0-9A-F]{8}) —/gm))
      ids.add(match[1]!);
    for (const match of source.text.matchAll(
      /<!-- Automation note \(([A-Z]+-[0-9A-F]{8})\): ([\s\S]*?) -->/g,
    )) {
      const id = match[1]!,
        explanation = match[2]!;
      if (
        /\bplanned\b|\bwill land\b|implementation increment/i.test(explanation)
      )
        errors.push(`stale planned automation note: ${id}`);
      noted.add(id);
    }
  }

  for (const source of testSources) {
    if (/(?:readFile|readFileSync)\s*\(\s*["'`]src\//.test(source.text))
      errors.push(
        `test inspects implementation source: ${relative(root, source.name)}`,
      );
    for (const title of testTitles(source.text)) {
      for (const match of title.matchAll(/\[([A-Z][A-Z0-9-]+)\]/g)) {
        const tag = match[1]!;
        if (!behaviorIdPattern.test(tag))
          errors.push(
            `malformed behavior tag [${tag}] in ${relative(root, source.name)}`,
          );
        else if (!ids.has(tag))
          errors.push(
            `unknown behavior tag [${tag}] in ${relative(root, source.name)}`,
          );
        else automated.add(tag);
      }
    }
  }

  for (const id of noted)
    if (!ids.has(id))
      errors.push(`automation note references unknown ID: ${id}`);
  for (const id of ids)
    if (!automated.has(id) && !noted.has(id))
      errors.push(`behavior has no executable test or automation note: ${id}`);

  return {
    behaviorCount: ids.size,
    scenarioCount,
    errors: [...new Set(errors)].sort(),
  };
}

const audit = await auditBehaviorCoverage();
if (audit.errors.length) {
  process.stderr.write(`${audit.errors.join("\n")}\n`);
  process.exitCode = 1;
} else
  process.stdout.write(
    `Behavior inventory: ${audit.behaviorCount} behavior IDs are traced across ${audit.scenarioCount} When paths.\n`,
  );
