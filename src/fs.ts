import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode).catch(() => undefined);
}

export async function atomicWrite(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path));
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { mode, flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await ensureDir(dirname(path));
  const handle = await open(path, "wx", 0o600);
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true });
  };
}
