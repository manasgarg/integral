import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { EffectiveConfig } from "./config.ts";
import type { Connection } from "./connections.ts";
import { RrError } from "./errors.ts";
import { atomicWrite, ensureDir } from "./fs.ts";
import { DEFAULT_PI_IMAGE, RR_VERSION } from "./constants.ts";

export interface ContainerSpec {
  image: string;
  args: string[];
  environment: Record<string, string>;
  mounts: { source: string; target: string; readonly: boolean }[];
  sessionId: string;
  sessionToken: string;
  home: string;
  gatewayAddress: string;
}

export interface PiRuntime {
  readonly spec: ContainerSpec;
  start(): Promise<void>;
  prompt(text: string): Promise<string>;
  stop(): Promise<void>;
}

export interface ContainerBackend {
  ensureImage(
    config: EffectiveConfig,
    piVersion: string,
  ): string | Promise<string>;
  ensureNetwork(name: string): Promise<void>;
  networkGateway(name: string): string | Promise<string>;
  createPi(
    spec: ContainerSpec,
    config: EffectiveConfig,
    network: string,
    onStderr: (line: string) => void,
  ): PiRuntime;
}
const managed = new Set([
  "HOME",
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "PIP_CERT",
]);
export function isManagedContainerVariable(name: string): boolean {
  return managed.has(name) || name.startsWith("RR_");
}

export function buildContainerSpec(options: {
  config: EffectiveConfig;
  gatewayUrl: string;
  gatewayAddress?: string;
  caCert: string;
  caBundle: string;
  sessionHome: string;
  sessionId: string;
  sessionToken: string;
  model: Connection;
  selectedModel: string;
  image?: string;
  mcp: Connection[];
}): ContainerSpec {
  const proxy = new URL(options.gatewayUrl);
  proxy.username = "rr";
  proxy.password = options.sessionToken;
  const proxyUrl = proxy.toString();
  const caPath = "/rr-ca/rr-ca.pem",
    bundlePath = "/rr-ca/ca-bundle.pem";
  const environment: Record<string, string> = {
    HOME: "/home/pi",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: "/tmp",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
    NODE_EXTRA_CA_CERTS: caPath,
    SSL_CERT_FILE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    REQUESTS_CA_BUNDLE: bundlePath,
    GIT_SSL_CAINFO: bundlePath,
    PIP_CERT: bundlePath,
  };
  const provider = options.model.provider!;
  // Pi sees only a sentinel. The gateway swaps it for the host credential inside the allowed boundary.
  environment[
    provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
  ] = "rr-managed-credential";
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-approve",
    "--offline",
    "--provider",
    provider,
    "--api-key",
    "rr-managed-credential",
  ];
  args.push("--model", options.selectedModel);
  return {
    image: options.image ?? options.config.runner.image,
    args,
    environment,
    mounts: [
      { source: options.caCert, target: caPath, readonly: true },
      { source: options.caBundle, target: bundlePath, readonly: true },
      { source: options.sessionHome, target: "/home/pi", readonly: false },
    ],
    sessionId: options.sessionId,
    sessionToken: options.sessionToken,
    home: options.sessionHome,
    gatewayAddress: options.gatewayAddress ?? "host-gateway",
  };
}

export function dockerRunArgs(
  spec: ContainerSpec,
  config: EffectiveConfig,
  network: string,
): string[] {
  const result = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    `rr-${spec.sessionId}`,
    "--network",
    network,
    "--add-host",
    `host.rr.internal:${spec.gatewayAddress}`,
    "--user",
    "1000:1000",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--memory",
    `${config.runner.memoryMb}m`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${config.runner.tmpfsMb}m`,
  ];
  for (const [name, value] of Object.entries(spec.environment))
    result.push("--env", `${name}=${value}`);
  for (const mount of spec.mounts)
    result.push(
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`,
    );
  return [...result, spec.image, "pi", ...spec.args];
}

export async function writeMcpExtension(
  sessionHome: string,
  connections: Connection[],
): Promise<void> {
  if (!connections.length) return;
  const directory = join(sessionHome, ".pi", "agent", "extensions");
  await ensureDir(directory);
  const declarations = connections.map((connection) => ({
    name: connection.name.replace(/[^A-Za-z0-9_]/g, "_"),
    url: connection.url,
    auth: connection.auth !== "none",
    transport: connection.transport,
  }));
  const source = `import { Type } from "typebox";\nconst servers = ${JSON.stringify(declarations)};\nfunction headers(server) { const value = { "content-type": "application/json", accept: "application/json, text/event-stream" }; if (server.auth) value.authorization = "Bearer rr-managed-credential"; return value; }\nasync function call(server, payload, signal) {\n  if (server.transport !== "sse") { const response = await fetch(server.url, { method: "POST", headers: headers(server), signal, body: JSON.stringify(payload) }); const body = await response.text(); if (!response.ok) throw new Error("MCP request failed: " + response.status); const data = body.split("\\n").filter(line => line.startsWith("data:")).at(-1)?.slice(5).trim(); return JSON.parse(data || body); }\n  const events = await fetch(server.url, { headers: headers(server), signal }); if (!events.ok || !events.body) throw new Error("MCP SSE connection failed: " + events.status); const reader = events.body.getReader(), decoder = new TextDecoder(); let buffer = "", endpoint;\n  while (!endpoint) { const part = await reader.read(); if (part.done) throw new Error("MCP SSE ended before endpoint"); buffer += decoder.decode(part.value, { stream: true }); const match = buffer.match(/event: endpoint\\r?\\ndata: (.+)\\r?\\n\\r?\\n/); if (match) { endpoint = new URL(match[1].trim(), server.url).toString(); buffer = buffer.slice((match.index || 0) + match[0].length); } }\n  const sent = await fetch(endpoint, { method: "POST", headers: headers(server), signal, body: JSON.stringify(payload) }); if (!sent.ok) throw new Error("MCP SSE send failed: " + sent.status);\n  while (true) { const match = buffer.match(/data: (.+)\\r?\\n\\r?\\n/); if (match) { buffer = buffer.slice((match.index || 0) + match[0].length); const value = JSON.parse(match[1]); if (value.id === payload.id) { await reader.cancel(); return value; } } const part = await reader.read(); if (part.done) throw new Error("MCP SSE ended before response"); buffer += decoder.decode(part.value, { stream: true }); }\n}\nexport default function (pi) {\n  for (const server of servers) pi.registerTool({\n    name: "mcp_" + server.name, label: "MCP " + server.name, description: "Call a tool on the " + server.name + " remote MCP server",\n    parameters: Type.Object({ tool: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),\n    async execute(_id, params, signal) {\n      const result = await call(server, { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: params.tool, arguments: params.arguments || {} } }, signal);\n      return { content: result.result?.content || [{ type: "text", text: JSON.stringify(result.result ?? result) }], details: { server: server.name } };\n    }\n  });\n}\n`;
  await atomicWrite(join(directory, "rr-mcp.ts"), source);
}

export function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}
function inspectImage(image: string): string | undefined {
  const result = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

export function managedPiImage(version: string): string {
  return `rr-pi:${RR_VERSION}-pi-${version.replace(/[^0-9A-Za-z_.-]/g, "-")}`;
}

export function ensureContainerImage(
  config: EffectiveConfig,
  piVersion: string,
): string {
  const requested =
    config.runner.image === DEFAULT_PI_IMAGE
      ? managedPiImage(piVersion)
      : config.runner.image;
  const existing = inspectImage(requested);
  if (config.runner.pullPolicy === "never") {
    if (!existing)
      throw new RrError(
        `container image is unavailable and pull_policy is never: ${requested}`,
      );
    return existing;
  }
  if (config.runner.pullPolicy === "if-not-present" && existing)
    return existing;
  if (config.runner.image === DEFAULT_PI_IMAGE) {
    const dockerfile = fileURLToPath(
      new URL("../../Dockerfile.pi", import.meta.url),
    );
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = spawnSync(
      "docker",
      [
        "build",
        "--pull",
        "--build-arg",
        `PI_VERSION=${piVersion}`,
        "--tag",
        requested,
        "--file",
        dockerfile,
        root,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new RrError(
        `cannot build Pi ${piVersion} image: ${result.stderr.trim()}`,
      );
    const identity = inspectImage(requested);
    if (!identity)
      throw new RrError(`cannot resolve Pi ${piVersion} image identity`);
    return identity;
  }
  const result = spawnSync("docker", ["pull", requested], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new RrError(
      `cannot pull Pi image ${requested}: ${result.stderr.trim()}`,
    );
  const identity = inspectImage(requested);
  if (!identity)
    throw new RrError(`cannot resolve Pi image identity: ${requested}`);
  return identity;
}

export async function discoverPiModels(
  image: string,
  providers: readonly string[],
): Promise<Array<{ provider: string; model: string }>> {
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--network", "none", "--read-only", image, "rr-pi-models"],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new RrError(
      `cannot discover models from Pi image: ${result.stderr.trim() || "container failed; the image must provide rr-pi-models"}`,
    );
  return parsePiModelList(result.stdout, providers);
}

export function parsePiModelList(
  output: string,
  providers: readonly string[],
): Array<{ provider: string; model: string }> {
  const allowed = new Set(providers);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new RrError("Pi image returned an invalid model catalog");
  }
  if (!Array.isArray(parsed))
    throw new RrError("Pi image returned an invalid model catalog");
  return (parsed as unknown[]).filter(
    (entry: unknown): entry is { provider: string; model: string } =>
      typeof entry === "object" &&
      entry !== null &&
      "provider" in entry &&
      typeof entry.provider === "string" &&
      allowed.has(entry.provider) &&
      "model" in entry &&
      typeof entry.model === "string" &&
      Boolean(entry.model),
  );
}

export function discoverPiVersion(image: string): string {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      image,
      "pi",
      "--version",
    ],
    { encoding: "utf8" },
  );
  const version = result.stdout.trim();
  if (result.status !== 0 || !version)
    throw new RrError(
      `cannot identify Pi image version: ${result.stderr.trim() || "container failed"}`,
    );
  return version;
}
export async function createLockedNetwork(name: string): Promise<void> {
  const inspect = spawnSync("docker", ["network", "inspect", name], {
    stdio: "ignore",
  });
  if (inspect.status === 0) return;
  const created = spawnSync(
    "docker",
    ["network", "create", "--internal", name],
    { encoding: "utf8" },
  );
  if (created.status !== 0)
    throw new RrError(
      `cannot create locked Docker network: ${created.stderr.trim()}`,
    );
}
export function dockerNetworkGateway(name: string): string {
  const result = spawnSync(
    "docker",
    [
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      name,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim())
    throw new RrError("cannot discover locked Docker network gateway");
  return result.stdout.trim();
}

export class PiContainer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private response = "";
  private pending:
    | {
        resolve: (text: string) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  constructor(
    readonly spec: ContainerSpec,
    private readonly config: EffectiveConfig,
    private readonly network: string,
    private readonly diagnostic: (line: string) => void = () => undefined,
  ) {}
  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(
      "docker",
      dockerRunArgs(this.spec, this.config, this.network),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.protocol(line),
    );
    createInterface({ input: child.stderr }).on("line", (line) =>
      this.diagnostic(line.replace(/[\r\n]/g, " ")),
    );
    child.once("exit", (code) => {
      const error = new RrError(
        `Pi container exited unexpectedly (${code ?? "signal"})`,
      );
      this.pending?.reject(error);
      this.pending = undefined;
      this.child = undefined;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  private protocol(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!this.pending) return;
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent as
        Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.delta === "string")
        this.response += delta.delta;
    }
    if (event.type === "agent_end") {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(this.response);
    }
  }
  prompt(text: string): Promise<string> {
    if (!this.child)
      return Promise.reject(new RrError("Pi container is not running"));
    if (this.pending)
      return Promise.reject(new RrError("Pi turn already in flight"));
    this.response = "";
    this.child.stdin.write(
      `${JSON.stringify({ type: "prompt", message: text })}\n`,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.stop();
        reject(new RrError("Pi turn timed out"));
      }, this.config.runner.turnTimeoutSeconds * 1000);
      this.pending = { resolve, reject, timer };
    });
  }
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = undefined;
    }
    if (child) {
      const exited = new Promise<boolean>((resolve) =>
        child.once("exit", () => resolve(true)),
      );
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!stopped) {
        spawnSync("docker", ["rm", "--force", `rr-${this.spec.sessionId}`], {
          stdio: "ignore",
        });
        await exited;
      }
    }
    await rm(this.spec.home, { recursive: true, force: true });
  }
}

export const dockerContainerBackend: ContainerBackend = {
  ensureImage: ensureContainerImage,
  ensureNetwork: createLockedNetwork,
  networkGateway: dockerNetworkGateway,
  createPi(spec, config, network, onStderr) {
    return new PiContainer(spec, config, network, onStderr);
  },
};

export async function freshSessionHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rr-pi-"));
}
export function newSessionIdentity(): {
  sessionId: string;
  sessionToken: string;
} {
  return {
    sessionId: randomUUID(),
    sessionToken: `${randomUUID()}${randomUUID()}`,
  };
}
