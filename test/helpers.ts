import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsFor, type RrPaths } from "../src/paths.ts";

export async function fixture(t: { after(fn: () => unknown): void }): Promise<RrPaths> {
  const root = await mkdtemp(join(tmpdir(), "rr-test-")); t.after(() => rm(root, { recursive: true, force: true })); return pathsFor(root);
}
