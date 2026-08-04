import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "integral-package-check-"));

try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm",
    packed = spawnSync(
      npm,
      ["pack", "--ignore-scripts", "--pack-destination", directory],
      { stdio: "inherit" },
    );
  if (packed.error) throw packed.error;
  if (packed.status !== 0) process.exitCode = packed.status ?? 1;
  else {
    const tarballs = (await readdir(directory)).filter((name) =>
      name.endsWith(".tgz"),
    );
    if (tarballs.length !== 1)
      throw new Error(
        `npm pack produced ${tarballs.length} tarballs instead of one`,
      );
    const linted = spawnSync(
      process.execPath,
      [
        join("node_modules", "publint", "src", "cli.js"),
        join(directory, tarballs[0]!),
      ],
      { stdio: "inherit" },
    );
    if (linted.error) throw linted.error;
    if (linted.status !== 0) process.exitCode = linted.status ?? 1;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
