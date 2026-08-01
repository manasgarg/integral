import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, initConfig } from "./config.ts";
import { RR_VERSION, PI_VERSION, COMPONENTS, type Component } from "./constants.ts";
import { CATALOG, listConnections, loadConnections, prepareStorage, removeConnection, removeCredential, saveConnection, validateConnection, type AuthMethod, type Connection } from "./connections.ts";
import { resolvePaths } from "./paths.ts";
import { messageOf, RrError } from "./errors.ts";
import { serverStatus, startComponents } from "./server.ts";
import { componentEndpoint, verifiedFetch } from "./http-client.ts";

const TOP_HELP = `rr — a governed, containerized Pi conversation

Usage: rr <command>

Commands:
  server       run or inspect server components
  talk         attach this terminal to the durable conversation
  connection   configure external connections
  config       inspect and validate configuration
  version      print implementation versions

Run rr <command> --help for command details.
`;
const CONFIG_HELP = `Usage: rr config <command>

Commands:
  init       create a commented starter configuration
  path       print the main configuration path
  show       show effective configuration after overrides
  validate   validate configuration without side effects
`;
const CONNECTION_HELP = `Usage: rr connection <command>

Commands:
  catalog    show model providers and generic connection types
  add        guided setup (or: add <entry> [options])
  ls         list configured connections
  rm <name>  deliberately remove a connection

All active connections are available automatically. There are no grant or revoke commands.
`;
const SERVER_HELP = `Usage: rr server start [--component <name>]
       rr server status [--json]

Combined mode is the default. --component <name> starts one component only.
Component values: coordinator, runner, gateway
`;
const TALK_HELP = `/help                         show this help
/status                       show shared chat status
/queue ls                     list queued and in-flight messages
/queue edit <id> <text>       edit a queued message
/queue delete <id>            delete a queued message
/exit                         detach this terminal
`;

function flag(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function has(args: string[], name: string): boolean { return args.includes(name); }
function writeJson(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

export async function main(args: string[]): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (!command || command === "--help" || command === "-h" || command === "help") { process.stdout.write(TOP_HELP); return 0; }
    if (command === "version" || command === "--version" || command === "-V") { process.stdout.write(`rr ${RR_VERSION}\nNode.js ${process.versions.node}\nPi ${PI_VERSION}\n`); return 0; }
    if (command === "config") return configCommand(rest);
    if (command === "connection") return connectionCommand(rest);
    if (command === "server") return serverCommand(rest);
    if (command === "talk") return talkCommand(rest);
    throw new RrError(`unknown command: ${command}`);
  } catch (error) { process.stderr.write(`rr: ${messageOf(error)}\n`); return error instanceof RrError ? error.exitCode : 1; }
}

async function configCommand(args: string[]): Promise<number> {
  const command = args[0]; if (!command || has(args, "--help") || command === "help") { process.stdout.write(CONFIG_HELP); return 0; }
  const paths = resolvePaths();
  if (command === "path") { process.stdout.write(`${paths.mainConfig}\n`); return 0; }
  if (command === "init") { await initConfig(paths); process.stdout.write(`Created ${paths.mainConfig}\n`); return 0; }
  if (command === "validate") {
    const errors: string[] = []; let config;
    try { config = await loadConfig(paths); } catch (error) { errors.push(messageOf(error)); }
    const loaded = await loadConnections(paths); errors.push(...loaded.errors);
    const result = { valid: errors.length === 0, errors, fingerprint: config?.fingerprint };
    if (has(args, "--json")) writeJson(result); else process.stdout.write(errors.length ? `Configuration is invalid:\n${errors.map((e) => `- ${e}`).join("\n")}\n` : "Configuration is valid.\n"); return errors.length ? 1 : 0;
  }
  if (command === "show") {
    const config = await loadConfig(paths), loaded = await loadConnections(paths); if (loaded.errors.length) throw new RrError(loaded.errors.join("\n"));
    const result = { server: config.server, runner: config.runner, conversation: config.conversation, logging: config.logging, model: config.model, connections: loaded.connections.map((c) => c.name), sources: config.sources };
    if (has(args, "--json")) writeJson(result); else { for (const [section, values] of Object.entries(result)) process.stdout.write(`${section}: ${JSON.stringify(values)}\n`); } return 0;
  }
  throw new RrError(`unknown config command: ${command}`);
}

async function connectionCommand(args: string[]): Promise<number> {
  const command = args[0]; if (!command || has(args, "--help") || command === "help") { process.stdout.write(CONNECTION_HELP); return 0; }
  if (command === "catalog") { for (const entry of CATALOG) process.stdout.write(`${entry.name}\t${entry.kind}\t${entry.auth.join(", ")}\n`); return 0; }
  const paths = resolvePaths();
  if (command === "ls") { const rows = await listConnections(paths); if (has(args, "--json")) writeJson(rows.map(({ name, kind, provider, auth, state }) => ({ name, kind, provider: provider ?? null, auth, state }))); else for (const row of rows) process.stdout.write(`${row.name}\t${row.provider ?? row.kind}\t${row.auth}\t${row.state}\n`); return 0; }
  if (command === "add") { await prepareStorage(paths); const setup = args[1] ? explicitConnection(args.slice(1)) : await guidedConnection(); const entry = CATALOG.find((e) => e.name === (setup.provider ?? setup.kind)); if (!entry || !entry.auth.includes(setup.auth as never)) throw new RrError(`${setup.provider ?? setup.kind} does not support ${setup.auth} authentication`);
    let credential: string | undefined; if (setup.auth !== "none") credential = await readCredential(has(args, "--credential-stdin"));
    if (has(args, "--verify")) await verifySetup(setup, credential);
    const result = await saveConnection(paths, setup, credential); process.stdout.write(`${result.rotated ? "Rotated" : "Added"} ${setup.name} (${setup.provider ?? setup.kind}, ${setup.auth})\n`); return 0;
  }
  if (command === "rm") { const name = args[1]; if (!name) throw new RrError("connection name is required"); const found = (await listConnections(paths)).find((c) => c.name === name); if (!found) throw new RrError(`connection not found: ${name}`);
    const rl = createInterface({ input, output }); try {
      if (found.auth !== "none") { const yes = await confirm(rl, `Remove credential for ${name}? [y/N] `); if (!yes) { process.stdout.write("Connection unchanged.\n"); return 0; } await removeCredential(paths, name); if (!await confirm(rl, `Remove connection record for ${name}? [y/N] `)) { process.stdout.write("Credential removed; connection record retained.\n"); return 0; } }
      else if (!await confirm(rl, `Remove connection record for ${name}? [y/N] `)) { process.stdout.write("Connection unchanged.\n"); return 0; }
      await removeConnection(paths, name); process.stdout.write(`Removed ${name}.\n`); return 0;
    } finally { rl.close(); }
  }
  throw new RrError(`unknown connection command: ${command}`);
}

function explicitConnection(args: string[]): Connection {
  const entryName = args[0]!, entry = CATALOG.find((e) => e.name === entryName); if (!entry) throw new RrError(`unknown catalog entry: ${entryName}`);
  const name = flag(args, "--name") ?? entryName; const auth = (flag(args, "--auth") ?? ("defaultAuth" in entry ? entry.defaultAuth : undefined)) as AuthMethod | undefined;
  const raw: Record<string, unknown> = { name, kind: entry.kind, auth };
  if (entry.kind === "model") raw.provider = entryName; else raw.url = flag(args, "--url");
  const methods = flag(args, "--methods"); if (methods) raw.methods = methods.split(",");
  for (const [option, key] of [["--path-prefix", "path_prefix"], ["--header", "header"], ["--scheme", "scheme"], ["--authorization-url", "authorization_url"], ["--token-url", "token_url"], ["--device-authorization-url", "device_authorization_url"], ["--client-id", "client_id"], ["--transport", "transport"]] as const) { const value = flag(args, option); if (value) raw[key] = value; }
  return validateConnection(raw);
}
async function guidedConnection(): Promise<Connection> {
  if (!input.isTTY) throw new RrError("guided connection setup requires an interactive terminal"); const rl = createInterface({ input, output });
  try { process.stdout.write(CATALOG.map((e, i) => `${i + 1}. ${e.name} (${e.kind}; ${e.auth.join(", ")})`).join("\n") + "\n"); const selected = Number(await rl.question("Select connection: ")) - 1, entry = CATALOG[selected]; if (!entry) throw new RrError("invalid selection"); const name = (await rl.question(`Name [${entry.name}]: `)).trim() || entry.name; const args = [entry.name, "--name", name]; if (entry.kind !== "model") args.push("--url", await rl.question("URL: ")); if (!("defaultAuth" in entry)) args.push("--auth", await rl.question(`Authentication (${entry.auth.join("/")}): `)); return explicitConnection(args); } finally { rl.close(); }
}
async function readCredential(fromStdin: boolean): Promise<string> { if (!fromStdin && !input.isTTY) throw new RrError("credential input requires a terminal or --credential-stdin"); const rl = createInterface({ input, output }); try { const value = (await rl.question(fromStdin ? "" : "Credential (input is not stored in config): ")).trim(); if (!value) throw new RrError("credential must not be empty"); return value; } finally { rl.close(); } }
async function verifySetup(connection: Connection, credential?: string): Promise<void> { if (!connection.url) return; const headers: Record<string, string> = {}; if (connection.auth !== "none") headers[connection.header ?? "Authorization"] = `${connection.scheme ?? "Bearer"} ${credential}`; const response = await fetch(connection.url, { method: "HEAD", headers }); if (!response.ok) throw new RrError(`connection verification failed: HTTP ${response.status}`); }
async function confirm(rl: ReturnType<typeof createInterface>, question: string): Promise<boolean> { return /^(y|yes)$/i.test((await rl.question(question)).trim()); }

async function serverCommand(args: string[]): Promise<number> {
  const command = args[0]; if (!command || has(args, "--help") || command === "help") { process.stdout.write(SERVER_HELP); return 0; } const paths = resolvePaths();
  if (command === "status") { const status = await serverStatus(paths); if (has(args, "--json")) writeJson(status); else { process.stdout.write(`deployment: ${status.overall}\n`); for (const component of COMPONENTS) process.stdout.write(`${component}: ${status.components[component].status}${status.components[component].endpoint ? ` (${status.components[component].endpoint})` : ""}\n`); } return status.overall === "healthy" ? 0 : 1; }
  if (command === "start") { const selected = flag(args, "--component"); if (selected && !COMPONENTS.includes(selected as Component)) throw new RrError(`invalid component: ${selected}`); const config = await loadConfig(paths); await startComponents(paths, config, selected as Component | undefined); return 0; }
  throw new RrError(`unknown server command: ${command}`);
}

async function talkCommand(args: string[]): Promise<number> {
  if (has(args, "--help")) { process.stdout.write(`Usage: rr talk\n\nAttach this terminal to the one durable deployment conversation.\n${TALK_HELP}`); return 0; }
  const paths = resolvePaths(); let endpoint: string;
  try { endpoint = await componentEndpoint(paths, "coordinator"); await verifiedFetch(paths, "coordinator", "/rr/health"); } catch { throw new RrError("coordinator is not reachable; start it with rr server start"); }
  const abort = new AbortController(); const response = await fetch(new URL("/rr/events", endpoint), { signal: abort.signal }); if (!response.ok || !response.body) throw new RrError("could not attach to coordinator");
  const follow = consumeEvents(response.body).catch((error) => { if (!abort.signal.aborted) process.stderr.write(`rr: ${messageOf(error)}\n`); });
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  try { while (true) { let line: string; try { line = await rl.question("rr> "); } catch { break; } const text = line.trim(); if (!text) continue; if (text === "/exit") break; if (text === "/help") { process.stdout.write(TALK_HELP); continue; }
      if (text === "/status") { const status = await fetchJson(new URL("/rr/status", endpoint)); writeJson(status); continue; }
      if (text === "/queue ls") { const snap = await fetchJson(new URL("/rr/snapshot", endpoint)) as { queue: { id: string; text: string; status: string }[] }; for (const item of snap.queue) process.stdout.write(`${item.status}\t${item.id}\t${item.text}\n`); continue; }
      const edit = text.match(/^\/queue edit\s+(\S+)\s+(.+)$/); if (edit) { await requestOk(new URL(`/rr/queue/${edit[1]}`, endpoint), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: edit[2] }) }); continue; }
      const del = text.match(/^\/queue delete\s+(\S+)$/); if (del) { await requestOk(new URL(`/rr/queue/${del[1]}`, endpoint), { method: "DELETE" }); continue; }
      if (text.startsWith("/")) { process.stderr.write("Unknown local command. Enter /help.\n"); continue; }
      await requestOk(new URL("/rr/messages", endpoint), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    } return 0;
  } finally { rl.close(); abort.abort(); await follow; }
}

async function consumeEvents(stream: ReadableStream<Uint8Array>): Promise<void> { const reader = stream.getReader(), decoder = new TextDecoder(); let buffer = ""; while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let boundary; while ((boundary = buffer.indexOf("\n\n")) >= 0) { const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); const event = block.match(/^event: (.+)$/m)?.[1], data = block.match(/^data: (.+)$/m)?.[1]; if (!data) continue; const value = JSON.parse(data) as Record<string, unknown>; if (event === "snapshot") { const snapshot = value as { conversation: { type: string; text?: string }[] }; for (const item of snapshot.conversation) if (item.text) process.stdout.write(`${item.type}: ${item.text}\n`); } else if (event === "conversation.user" || event === "conversation.assistant" || event === "conversation.error") { const item = value as { type: string; text?: string }; if (item.text) process.stdout.write(`${item.type}: ${item.text}\n`); } } } }
async function fetchJson(url: URL): Promise<unknown> { const response = await fetch(url); if (!response.ok) throw new RrError((await response.json() as { error?: string }).error ?? `request failed: ${response.status}`); return response.json(); }
async function requestOk(url: URL, init: RequestInit): Promise<void> { const response = await fetch(url, init); if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new RrError(body.error ?? `request failed: ${response.status}`); } }
