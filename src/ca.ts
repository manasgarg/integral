import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensureDir } from "./fs.ts";
import type { IntegralPaths } from "./paths.ts";

const exec = promisify(execFile);
export interface CaFiles {
  key: string;
  cert: string;
  bundle: string;
}
export async function ensureCa(paths: IntegralPaths): Promise<CaFiles> {
  await ensureDir(paths.ca);
  const key = join(paths.ca, "integral-ca.key"),
    cert = join(paths.ca, "integral-ca.pem"),
    bundle = join(paths.ca, "ca-bundle.pem");
  try {
    await access(key);
    await access(cert);
  } catch {
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-sha256",
      "-nodes",
      "-days",
      "3650",
      "-subj",
      "/CN=integral local gateway CA",
      "-keyout",
      key,
      "-out",
      cert,
    ]);
  }
  const integral = await readFile(cert);
  let system = Buffer.alloc(0);
  try {
    system = await readFile("/etc/ssl/certs/ca-certificates.crt");
  } catch {
    /* platform without this bundle */
  }
  const { atomicWrite } = await import("./fs.ts");
  await atomicWrite(
    bundle,
    Buffer.concat([system, Buffer.from("\n"), integral]),
  );
  return { key, cert, bundle };
}

export async function certificateFor(
  paths: IntegralPaths,
  host: string,
  ca: CaFiles,
): Promise<{ key: string; cert: string }> {
  const id = createHash("sha256").update(host).digest("hex");
  const dir = join(paths.ca, "hosts");
  await ensureDir(dir);
  const key = join(dir, `${id}.key`),
    csr = join(dir, `${id}.csr`),
    cert = join(dir, `${id}.pem`),
    ext = join(dir, `${id}.ext`);
  try {
    await access(key);
    await access(cert);
    return { key, cert };
  } catch {
    /* create below */
  }
  const { atomicWrite } = await import("./fs.ts");
  const san = /^[\d.:]+$/.test(host) ? `IP:${host}` : `DNS:${host}`;
  await atomicWrite(
    ext,
    `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`,
  );
  await exec("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${host}`,
    "-keyout",
    key,
    "-out",
    csr,
  ]);
  await exec("openssl", [
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca.cert,
    "-CAkey",
    ca.key,
    "-CAcreateserial",
    "-days",
    "30",
    "-sha256",
    "-extfile",
    ext,
    "-out",
    cert,
  ]);
  return { key, cert };
}
