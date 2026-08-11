import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const behaviorIdPattern = /^[A-Z]+-[0-9A-F]{8}$/;
const clausePattern = /^(\t*)((?:Given|When|Then|And|Or) .+)$/;

interface SourceFile {
  name: string;
  text: string;
}

interface BehaviorDefinition {
  id: string;
  clauses: string[];
  noted: boolean;
}

interface TestTitle {
  index: number;
  title: string;
}

export interface BehaviorCoverageAudit {
  behaviorCount: number;
  scenarioCount: number;
  clauseCount: number;
  coveredClauseCount: number;
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

function testTitles(source: string): TestTitle[] {
  return [
    ...source.matchAll(
      /\b(?:test|it)\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g,
    ),
  ].map((match) => ({
    index: match.index,
    title: match[1] ?? match[2] ?? match[3] ?? "",
  }));
}

function behaviorDefinitions(
  behaviorSources: SourceFile[],
  errors: string[],
): Map<string, BehaviorDefinition> {
  const definitions = new Map<string, BehaviorDefinition>();
  for (const source of behaviorSources) {
    const headings = [...source.text.matchAll(/^## ([A-Z]+-[0-9A-F]{8}) —/gm)];
    for (const [index, heading] of headings.entries()) {
      const id = heading[1]!,
        body = source.text.slice(
          heading.index,
          headings[index + 1]?.index ?? source.text.length,
        ),
        clauses = body.split("\n").filter((line) => clausePattern.test(line));
      if (definitions.has(id)) errors.push(`duplicate behavior ID: ${id}`);
      definitions.set(id, {
        id,
        clauses,
        noted: false,
      });
    }
    for (const match of source.text.matchAll(
      /<!-- Automation note \(([A-Z]+-[0-9A-F]{8})\): ([\s\S]*?) -->/g,
    )) {
      const id = match[1]!,
        explanation = match[2]!,
        definition = definitions.get(id);
      if (
        /\bplanned\b|\bwill land\b|implementation increment/i.test(explanation)
      )
        errors.push(`stale planned automation note: ${id}`);
      if (!definition)
        errors.push(`automation note references unknown ID: ${id}`);
      else definition.noted = true;
    }
  }
  return definitions;
}

function annotationClauses(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/^ ?\* ?/, ""))
    .filter((line) => clausePattern.test(line));
}

function matchClauseSequence(
  definition: BehaviorDefinition,
  declared: string[],
): { indexes?: number[]; error?: string } {
  if (!declared.length) return { error: "coverage block has no clauses" };
  const matches: number[][] = [];
  const visit = (declaredIndex: number, after: number, found: number[]) => {
    if (declaredIndex === declared.length) {
      matches.push(found);
      return;
    }
    for (let index = after; index < definition.clauses.length; index++)
      if (definition.clauses[index] === declared[declaredIndex])
        visit(declaredIndex + 1, index + 1, [...found, index]);
  };
  visit(0, 0, []);
  if (!matches.length)
    return { error: "coverage block does not match the behavior clause text" };
  if (matches.length > 1)
    return {
      error:
        "coverage block is ambiguous; include more surrounding clause text",
    };
  return { indexes: matches[0]! };
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
    errors: string[] = [],
    definitions = behaviorDefinitions(behaviorSources, errors),
    automated = new Set<string>(),
    coverage = new Map<string, Set<number>>();

  for (const source of testSources) {
    const relativeName = relative(root, source.name),
      titles = testTitles(source.text);
    if (/(?:readFile|readFileSync)\s*\(\s*["'`]src\//.test(source.text))
      errors.push(`test inspects implementation source: ${relativeName}`);
    for (const { title } of titles) {
      for (const match of title.matchAll(/\[([A-Z][A-Z0-9-]+)\]/g)) {
        const tag = match[1]!;
        if (!behaviorIdPattern.test(tag))
          errors.push(`malformed behavior tag [${tag}] in ${relativeName}`);
        else if (!definitions.has(tag))
          errors.push(`unknown behavior tag [${tag}] in ${relativeName}`);
        else automated.add(tag);
      }
    }
    for (const match of source.text.matchAll(
      /\/\* @covers ([A-Z]+-[0-9A-F]{8})\n([\s\S]*?)\*\//g,
    )) {
      const id = match[1]!,
        definition = definitions.get(id),
        nextTest = titles.find((title) => title.index > match.index);
      if (!definition) {
        errors.push(`unknown clause coverage ID ${id} in ${relativeName}`);
        continue;
      }
      if (!nextTest || !nextTest.title.includes(`[${id}]`)) {
        errors.push(
          `clause coverage for ${id} is not followed by a test tagged [${id}] in ${relativeName}`,
        );
        continue;
      }
      const result = matchClauseSequence(
        definition,
        annotationClauses(match[2]!),
      );
      if (result.error) {
        errors.push(`${id} in ${relativeName}: ${result.error}`);
        continue;
      }
      const covered = coverage.get(id) ?? new Set<number>();
      for (const index of result.indexes!) covered.add(index);
      coverage.set(id, covered);
    }
  }

  let scenarioCount = 0,
    clauseCount = 0,
    coveredClauseCount = 0;
  for (const definition of definitions.values()) {
    scenarioCount += definition.clauses.filter((clause) =>
      /^\tWhen /.test(clause),
    ).length;
    clauseCount += definition.clauses.length;
    if (!automated.has(definition.id)) {
      if (!definition.noted)
        errors.push(
          `behavior has no executable test or automation note: ${definition.id}`,
        );
      continue;
    }
    const covered = coverage.get(definition.id) ?? new Set<number>();
    coveredClauseCount += covered.size;
    for (const [index, clause] of definition.clauses.entries())
      if (!covered.has(index))
        errors.push(`uncovered clause ${definition.id}: ${clause.trim()}`);
  }

  return {
    behaviorCount: definitions.size,
    scenarioCount,
    clauseCount,
    coveredClauseCount,
    errors: [...new Set(errors)].sort(),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const audit = await auditBehaviorCoverage();
  if (audit.errors.length) {
    process.stderr.write(`${audit.errors.join("\n")}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write(
      `Behavior inventory: ${audit.behaviorCount} behavior IDs and ${audit.coveredClauseCount}/${audit.clauseCount} executable clauses are traced across ${audit.scenarioCount} When paths.\n`,
    );
}
