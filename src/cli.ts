import { createInterface } from "node:readline/promises";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, initConfig } from "./config.ts";
import type { EffectiveConfig } from "./config.ts";
import { INTEGRAL_VERSION, COMPONENTS, type Component } from "./constants.ts";
import {
  CATALOG,
  listConnections,
  loadConnections,
  prepareStorage,
  removeConnection,
  removeCredential,
  saveConnection,
  validateConnection,
  type AuthMethod,
  type Connection,
} from "./connections.ts";
import { resolvePaths } from "./paths.ts";
import { messageOf, IntegralError } from "./errors.ts";
import { serverStatus, startComponents } from "./server.ts";
import { componentEndpoint, verifiedFetch } from "./http-client.ts";
import { oauthAccess, runGenericOAuth, runModelOAuth } from "./oauth.ts";
import type { IntegralPaths } from "./paths.ts";
import {
  discoverMcpAuthorization,
  discoverRemoteMcp,
  type McpCatalog,
} from "./mcp.ts";
import { addHostResource, softDeleteResource } from "./resources.ts";
import {
  matchModelChoices,
  sameModel,
  sameSelection,
  type ModelChoice,
  type ModelSelection,
} from "./model-selection.ts";
import { imageCommand } from "./cli/image.ts";
export { imageCommand, type ImageCommandDependencies } from "./cli/image.ts";
import { queueCommand } from "./cli/queue.ts";
export { queueCommand, type QueueDependencies } from "./cli/queue.ts";
import { fetchJson, requestJson, requestOk } from "./cli/http.ts";

const TOP_HELP = `integral — a governed, containerized Pi conversation

Usage: integral <command>

Commands:
  server       run or inspect server components
  talk         attach this terminal to the durable conversation
  queue        inspect or change queued messages
  schedule     manage schedules and inspect task executions
  connection   configure external connections
  image        edit or rebuild the managed Pi image
  config       inspect and validate configuration
  version      print implementation versions

Run integral <command> --help for command details.
`;
const CONFIG_HELP = `Usage: integral config <command>

Commands:
  init       create a commented starter configuration
  path       print the main configuration path
  show       show effective configuration after overrides
  validate   validate configuration without side effects
`;
const CONNECTION_HELP = `Usage: integral connection <command>

Commands:
  catalog    show model, email, generic, and host-resource connection types
  add        guided setup (or: add <entry> --auth <method> [options])
  ls         list configured connections
  rm <name>  deliberately remove a connection

All active connections are available automatically. There are no grant or revoke commands.

MCP options:
  --transport <streamable-http|sse|stdio>
  --command <executable>  stdio executable in the configured runner image
  --arg <value>           repeat for each literal stdio argument
  --env <name>=<value>    repeat for non-secret stdio environment values
  --secret-env <name>     repeat for protected stdio environment values
  --allow-url <url>       repeat to allow bounded stdio sidecar egress

Email examples:
  integral connection add gmail --auth oauth --account <email> --client-id <id> --capabilities read,search,send --allowed-recipients <addresses>
  integral connection add mailgun --auth key --domain <domain> --from <email> --capabilities send --allowed-recipients <addresses>

Host-resource paths:
  --path resolves relative paths from the current directory
  --mount resolves relative paths below /home/pi
`;
const SERVER_HELP = `Usage: integral server start [--component <name>]
       integral server status [--json]

Combined mode is the default. --component <name> starts one component only.
Component values: coordinator, runner, gateway, scheduler
`;
const SCHEDULE_HELP = `Usage: integral schedule <command>

Commands:
  ls [--json]                              list active schedules
  show <id> [--json]                       show one schedule
  history <id> [--json]                    show definition revisions
  runs [<id>] [--json]                     show occurrence and attempt history
  create --prompt <text> (--cron <expr> --timezone <zone> | --at <instant>)
  update <id> --revision <n> [trigger and prompt options]
  enable|disable|delete <id> --revision <n>
  restore <id> <commit> --revision <n>      restore as a new revision
  cancel <execution-id>                    cancel an active one-time task
`;
const TALK_HELP = `/help                         show this help
/status                       show shared chat status
/model [<pattern>...]         show or change the provider and model
/queue ls                     list queued and in-flight messages
/queue edit <id> <text>       edit a queued message
/queue delete <id>            delete a queued message
/approvals                    list governed requests awaiting a human
/approve <id>                 approve one governed request
/deny <id>                    deny one governed request
/exit                         detach this terminal
`;
const TALK_USER_STYLE = "\u001b[48;5;238m\u001b[97m";
const TALK_STYLE_RESET = "\u001b[0m";
const TALK_WORK_FRAMES = ["∮   ", "∮·  ", "∮·· ", "∮···"] as const;
const VERSION_HELP = `Usage: integral version

Print the integral, Node.js, and supported Pi versions.
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function flags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++)
    if (args[index] === name && args[index + 1] !== undefined)
      values.push(args[index + 1]!);
  return values;
}
function has(args: string[], name: string): boolean {
  return args.includes(name);
}
function helpRequested(args: string[]): boolean {
  return has(args, "--help") || has(args, "-h");
}
function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function renderEffectiveConfig(
  config: EffectiveConfig,
  connections: string[],
): string {
  const sections: Array<
    [string, Array<[string, string | number, string | undefined]>]
  > = [
    [
      "server",
      [
        ["gateway_port", config.server.gatewayPort, "server.gateway_port"],
        [
          "coordinator_port",
          config.server.coordinatorPort,
          "server.coordinator_port",
        ],
        ["runner_port", config.server.runnerPort, "server.runner_port"],
        [
          "scheduler_port",
          config.server.schedulerPort,
          "server.scheduler_port",
        ],
      ],
    ],
    [
      "runner",
      [
        ["image", config.runner.image, "runner.image"],
        ["pull_policy", config.runner.pullPolicy, "runner.pull_policy"],
        [
          "turn_timeout_seconds",
          config.runner.turnTimeoutSeconds,
          "runner.turn_timeout_seconds",
        ],
        [
          "idle_timeout_seconds",
          config.runner.idleTimeoutSeconds,
          "runner.idle_timeout_seconds",
        ],
        ["memory_mb", config.runner.memoryMb, "runner.memory_mb"],
        ["tmpfs_mb", config.runner.tmpfsMb, "runner.tmpfs_mb"],
      ],
    ],
    [
      "conversation",
      [
        [
          "context_max_messages",
          config.conversation.contextMaxMessages,
          "conversation.context_max_messages",
        ],
        [
          "context_max_chars",
          config.conversation.contextMaxChars,
          "conversation.context_max_chars",
        ],
      ],
    ],
    [
      "logging",
      [
        ["level", config.logging.level, "logging.level"],
        ["format", config.logging.format, "logging.format"],
      ],
    ],
    [
      "repositories",
      [
        [
          "max_file_bytes",
          config.repositories.maxFileBytes,
          "repositories.max_file_bytes",
        ],
        [
          "max_repo_bytes",
          config.repositories.maxRepoBytes,
          "repositories.max_repo_bytes",
        ],
        [
          "recovery_retention_days",
          config.repositories.recoveryRetentionDays,
          "repositories.recovery_retention_days",
        ],
      ],
    ],
    ["stores", [["snapshots", config.stores.snapshots, "stores.snapshots"]]],
  ];
  const lines = ["Effective configuration"];
  for (const [section, values] of sections) {
    lines.push("", `[${section}]`);
    for (const [key, value, source] of values)
      lines.push(
        `${key} = ${typeof value === "string" ? JSON.stringify(value) : value}${source ? `  # source: ${config.sources[source]}` : ""}`,
      );
  }
  lines.push("", "[connections]", `names = ${JSON.stringify(connections)}`, "");
  return lines.join("\n");
}

export async function main(args: string[]): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (
      !command ||
      command === "--help" ||
      command === "-h" ||
      command === "help"
    ) {
      process.stdout.write(TOP_HELP);
      return 0;
    }
    if (command === "version" || command === "--version" || command === "-V") {
      if (helpRequested(rest)) {
        process.stdout.write(VERSION_HELP);
        return 0;
      }
      process.stdout.write(
        `integral ${INTEGRAL_VERSION}\nNode.js ${process.versions.node}\nPi runtime: latest (resolved when needed)\n`,
      );
      return 0;
    }
    if (command === "config") return await configCommand(rest);
    if (command === "connection") return await connectionCommand(rest);
    if (command === "image") return await imageCommand(rest);
    if (command === "server") return await serverCommand(rest);
    if (command === "queue") return await queueCommand(rest);
    if (command === "schedule") return await scheduleCommand(rest);
    if (command === "talk") return await talkCommand(rest);
    throw new IntegralError(`unknown command: ${command}`);
  } catch (error) {
    process.stderr.write(`integral: ${messageOf(error)}\n`);
    return error instanceof IntegralError ? error.exitCode : 1;
  }
}

async function configCommand(args: string[]): Promise<number> {
  const command = args[0];
  if (!command || helpRequested(args) || command === "help") {
    process.stdout.write(CONFIG_HELP);
    return 0;
  }
  const paths = resolvePaths();
  if (command === "path") {
    process.stdout.write(`${paths.mainConfig}\n`);
    return 0;
  }
  if (command === "init") {
    await initConfig(paths);
    process.stdout.write(`Created ${paths.mainConfig}\n`);
    return 0;
  }
  if (command === "validate") {
    const errors: string[] = [];
    let config: EffectiveConfig | undefined;
    try {
      config = await loadConfig(paths);
    } catch (error) {
      errors.push(messageOf(error));
    }
    const loaded = await loadConnections(paths);
    errors.push(...loaded.errors);
    const result = {
      valid: errors.length === 0,
      errors,
      fingerprint: config?.fingerprint,
    };
    if (has(args, "--json")) writeJson(result);
    else
      process.stdout.write(
        errors.length
          ? `Configuration is invalid:\n${errors.map((e) => `- ${e}`).join("\n")}\n`
          : "Configuration is valid.\n",
      );
    return errors.length ? 1 : 0;
  }
  if (command === "show") {
    const config = await loadConfig(paths),
      loaded = await loadConnections(paths);
    if (loaded.errors.length) throw new IntegralError(loaded.errors.join("\n"));
    const result = {
      server: config.server,
      runner: config.runner,
      conversation: config.conversation,
      logging: config.logging,
      connections: loaded.connections.map((c) => c.name),
      sources: config.sources,
    };
    if (has(args, "--json")) writeJson(result);
    else
      process.stdout.write(renderEffectiveConfig(config, result.connections));
    return 0;
  }
  throw new IntegralError(`unknown config command: ${command}`);
}

async function connectionCommand(args: string[]): Promise<number> {
  const command = args[0];
  if (!command || helpRequested(args) || command === "help") {
    process.stdout.write(CONNECTION_HELP);
    return 0;
  }
  if (command === "catalog") {
    for (const entry of CATALOG)
      process.stdout.write(
        `${entry.name}\t${entry.kind}\t${entry.auth.join(", ")}\n`,
      );
    return 0;
  }
  const paths = resolvePaths();
  if (command === "ls") {
    const rows = await listConnections(paths);
    if (has(args, "--json"))
      writeJson(
        rows.map(
          ({
            name,
            kind,
            provider,
            auth,
            state,
            mount,
            resourceId,
            lifecycleRevision,
            availabilityReason,
          }) => ({
            name,
            kind,
            provider: provider ?? null,
            auth,
            state,
            ...(kind === "host-repo" || kind === "host-store"
              ? {
                  resourceId,
                  lifecycleRevision,
                  mount,
                  availabilityReason: availabilityReason ?? null,
                }
              : {}),
          }),
        ),
      );
    else
      for (const row of rows)
        process.stdout.write(
          `${row.name}\t${row.provider ?? row.kind}\t${row.auth}\t${row.state}${row.mount ? `\t${row.mount}` : ""}\n`,
        );
    return 0;
  }
  if (command === "add") {
    await prepareStorage(paths);
    let setup = args[1]
      ? await explicitConnection(args.slice(1))
      : await guidedConnection();
    if (
      setup.kind === "mcp" &&
      setup.transport !== "stdio" &&
      !flag(args, "--auth")
    )
      setup = (await discoverMcpAuthorization(setup)) ?? setup;
    const entry = CATALOG.find(
      (e) => e.name === (setup.provider ?? setup.kind),
    );
    if (!entry || !entry.auth.includes(setup.auth as never))
      throw new IntegralError(
        `${setup.provider ?? setup.kind} does not support ${setup.auth} authentication`,
      );
    if (setup.kind === "host-repo" || setup.kind === "host-store") {
      const resource = await addHostResource(
        paths,
        setup,
        await loadConfig(paths),
      );
      process.stdout.write(
        `Added ${setup.name} (${setup.kind}, ${resource.mount}, revision ${resource.revision})\n`,
      );
      return 0;
    }
    let credential: string | undefined, catalog: McpCatalog | undefined;
    if (setup.transport === "stdio" && setup.secretEnv?.length)
      credential = await readStdioCredentials(
        setup.secretEnv,
        has(args, "--credential-stdin"),
      );
    else if (setup.auth === "key")
      credential = await readCredential(has(args, "--credential-stdin"));
    else if (setup.auth === "oauth" || setup.auth === "device-code")
      credential = await authenticateOAuth(paths, setup);
    if (setup.kind === "mcp" && setup.transport !== "stdio")
      catalog = await discoverRemoteMcp(
        setup,
        credential ? (oauthAccess(credential) ?? credential) : undefined,
      );
    if (has(args, "--verify")) await verifySetup(setup, credential);
    const result = await saveConnection(paths, setup, credential);
    process.stdout.write(
      `${result.rotated ? "Rotated" : "Added"} ${setup.name} (${setup.provider ?? setup.kind}, ${setup.auth}${catalog ? `, ${catalog.protocolVersion}, ${catalog.tools.length} tools` : ""})\n`,
    );
    return 0;
  }
  if (command === "rm") {
    const name = args[1];
    if (!name) throw new IntegralError("connection name is required");
    const found = (await listConnections(paths)).find((c) => c.name === name);
    if (!found) throw new IntegralError(`connection not found: ${name}`);
    const rl = createInterface({ input, output });
    try {
      if (found.kind === "host-repo" || found.kind === "host-store") {
        const revision = found.lifecycleRevision!;
        if (
          !(await confirm(
            rl,
            `Soft-delete ${found.kind} ${name} at revision ${revision}? Existing sessions retain it until they end. [y/N] `,
          ))
        ) {
          process.stdout.write("Connection unchanged.\n");
          return 0;
        }
        await softDeleteResource(paths, name, revision, "operator");
        process.stdout.write(
          `Soft-deleted ${name}; existing sessions retain their checkout or mount until they end.\n`,
        );
        return 0;
      }
      if (found.auth !== "none") {
        const yes = await confirm(rl, `Remove credential for ${name}? [y/N] `);
        if (!yes) {
          process.stdout.write("Connection unchanged.\n");
          return 0;
        }
        await removeCredential(paths, name);
        if (
          !(await confirm(rl, `Remove connection record for ${name}? [y/N] `))
        ) {
          process.stdout.write(
            "Credential removed; connection record retained.\n",
          );
          return 0;
        }
      } else if (
        !(await confirm(rl, `Remove connection record for ${name}? [y/N] `))
      ) {
        process.stdout.write("Connection unchanged.\n");
        return 0;
      }
      await removeConnection(paths, name);
      process.stdout.write(`Removed ${name}.\n`);
      return 0;
    } finally {
      rl.close();
    }
  }
  throw new IntegralError(`unknown connection command: ${command}`);
}

export async function explicitConnection(args: string[]): Promise<Connection> {
  const entryName = args[0]!,
    entry = CATALOG.find((e) => e.name === entryName);
  if (!entry) throw new IntegralError(`unknown catalog entry: ${entryName}`);
  const name = flag(args, "--name") ?? entryName;
  const requestedAuth = flag(args, "--auth"),
    transport = flag(args, "--transport");
  let ask: ((message: string) => Promise<string>) | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  if (!requestedAuth && entry.auth.length > 1 && input.isTTY) {
    rl = createInterface({ input, output });
    ask = (message) => rl!.question(message);
  }
  let auth: AuthMethod;
  try {
    auth =
      entry.kind === "mcp" && !requestedAuth
        ? "none"
        : await selectAuthentication(entry.auth, requestedAuth, ask);
  } finally {
    rl?.close();
  }
  const raw: Record<string, unknown> = { name, kind: entry.kind, auth };
  if (entry.name === "github") {
    raw.provider = entry.name;
    raw.hosts = [...entry.hosts];
  } else if (entry.kind === "model" || entry.kind === "email") {
    raw.provider = entryName;
  } else if (entry.kind === "host-repo" || entry.kind === "host-store") {
    const path = flag(args, "--path"),
      mount = flag(args, "--mount");
    raw.path = path ? resolve(path) : path;
    raw.mount = mount ? resolve("/home/pi", mount) : mount;
    if (entry.kind === "host-repo") raw.branch = flag(args, "--branch");
  } else if (entry.kind === "mcp" && transport === "stdio") {
    raw.transport = "stdio";
    raw.command = flag(args, "--command");
    raw.args = flags(args, "--arg");
    const env: Record<string, string> = {};
    for (const item of flags(args, "--env")) {
      const separator = item.indexOf("=");
      if (separator <= 0)
        throw new IntegralError("--env requires <name>=<value>");
      const key = item.slice(0, separator);
      if (Object.hasOwn(env, key))
        throw new IntegralError(`duplicate --env name: ${key}`);
      env[key] = item.slice(separator + 1);
    }
    raw.env = env;
    raw.secret_env = flags(args, "--secret-env");
    raw.allowed_urls = flags(args, "--allow-url");
  } else raw.url = flag(args, "--url");
  const methods = flag(args, "--methods");
  if (methods) raw.methods = methods.split(",");
  for (const [option, key] of [
    ["--path-prefix", "path_prefix"],
    ["--header", "header"],
    ["--scheme", "scheme"],
    ["--authorization-url", "authorization_url"],
    ["--token-url", "token_url"],
    ["--device-authorization-url", "device_authorization_url"],
    ["--client-id", "client_id"],
    ["--transport", "transport"],
    ["--account", "account"],
    ["--domain", "domain"],
    ["--from", "from_address"],
    ["--region", "region"],
  ] as const) {
    const value = flag(args, option);
    if (value) raw[key] = value;
  }
  for (const [option, key] of [
    ["--capabilities", "capabilities"],
    ["--allowed-recipients", "allowed_recipients"],
  ] as const) {
    const value = flag(args, option);
    if (value) raw[key] = commaSeparated(value);
  }
  let details: ReturnType<typeof createInterface> | undefined;
  try {
    await completeEmailOptions(
      entryName,
      raw,
      input.isTTY
        ? (message) => {
            details ??= createInterface({ input, output });
            return details.question(message);
          }
        : undefined,
    );
  } finally {
    details?.close();
  }
  return validateConnection(raw);
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function completeEmailOptions(
  provider: string,
  raw: Record<string, unknown>,
  ask?: (message: string) => Promise<string>,
): Promise<void> {
  if (provider !== "gmail" && provider !== "mailgun") return;
  if (raw.capabilities === undefined && provider === "mailgun")
    raw.capabilities = ["send"];
  if (raw.capabilities === undefined && ask) {
    const defaults = "read,search,send";
    raw.capabilities = commaSeparated(
      (await ask(`Capabilities [${defaults}]: `)).trim() || defaults,
    );
  }
  if (provider === "gmail") {
    if (raw.account === undefined && ask)
      raw.account = await ask("Account email: ");
    if (raw.client_id === undefined && ask)
      raw.client_id = await ask("OAuth client ID: ");
  } else {
    if (raw.domain === undefined && ask)
      raw.domain = await ask("Mailgun domain: ");
    if (raw.from_address === undefined && ask)
      raw.from_address = await ask("From address: ");
  }
  if (
    Array.isArray(raw.capabilities) &&
    raw.capabilities.includes("send") &&
    raw.allowed_recipients === undefined &&
    ask
  )
    raw.allowed_recipients = commaSeparated(
      await ask("Allowed recipients (comma-separated): "),
    );
}

export async function selectAuthentication(
  supported: readonly AuthMethod[],
  requested?: string,
  ask?: (message: string) => Promise<string>,
): Promise<AuthMethod> {
  if (requested) {
    if (!supported.includes(requested as AuthMethod))
      throw new IntegralError(
        `authentication method ${requested} is not supported; choose one of: ${supported.join(", ")}`,
      );
    return requested as AuthMethod;
  }
  if (supported.length === 1) return supported[0]!;
  if (!ask)
    throw new IntegralError(
      `authentication method is required in a non-interactive terminal; use --auth with one of: ${supported.join(", ")}`,
    );
  const selected = (await ask(`Authentication (${supported.join("/")}): `))
    .trim()
    .toLowerCase();
  if (!supported.includes(selected as AuthMethod))
    throw new IntegralError(
      `authentication method must be one of: ${supported.join(", ")}`,
    );
  return selected as AuthMethod;
}
async function guidedConnection(): Promise<Connection> {
  if (!input.isTTY)
    throw new IntegralError(
      "guided connection setup requires an interactive terminal",
    );
  const rl = createInterface({ input, output });
  try {
    process.stdout.write(
      CATALOG.map(
        (e, i) => `${i + 1}. ${e.name} (${e.kind}; ${e.auth.join(", ")})`,
      ).join("\n") + "\n",
    );
    const selected = Number(await rl.question("Select connection: ")) - 1,
      entry = CATALOG[selected];
    if (!entry) throw new IntegralError("invalid selection");
    const name =
      (await rl.question(`Name [${entry.name}]: `)).trim() || entry.name;
    if (entry.kind === "mcp") {
      const transport = (
          await rl.question(
            "Transport (auto/streamable-http/sse/stdio) [auto]: ",
          )
        ).trim(),
        args = [entry.name, "--name", name, "--auth", "none"];
      if (transport === "stdio") {
        args.push(
          "--transport",
          "stdio",
          "--command",
          await rl.question("Command: "),
        );
        while (true) {
          const argument = await rl.question("Argument [done]: ");
          if (!argument) break;
          args.push("--arg", argument);
        }
      } else {
        args.push("--url", await rl.question("URL: "));
        if (transport && transport !== "auto")
          args.push("--transport", transport);
      }
      return explicitConnection(args);
    }
    const defaultAuth =
        "defaultAuth" in entry ? entry.defaultAuth : entry.auth[0],
      chosenAuth =
        entry.auth.length === 1
          ? entry.auth[0]
          : (
              await rl.question(
                `Authentication (${entry.auth.join("/")}) [${defaultAuth}]: `,
              )
            ).trim() || defaultAuth;
    const args = [entry.name, "--name", name, "--auth", chosenAuth];
    if (entry.kind === "http" && entry.name !== "github") {
      args.push("--url", await rl.question("URL: "));
      const path = (await rl.question("Path prefix [URL path]: ")).trim();
      if (path) args.push("--path-prefix", path);
    }
    if (
      entry.kind === "http" &&
      (chosenAuth === "oauth" || chosenAuth === "device-code")
    ) {
      args.push(
        "--authorization-url",
        await rl.question("Authorization URL: "),
        "--token-url",
        await rl.question("Token URL: "),
        "--client-id",
        await rl.question("Client ID: "),
      );
      if (chosenAuth === "device-code")
        args.push(
          "--device-authorization-url",
          await rl.question("Device authorization URL: "),
        );
    }
    if (entry.kind === "email") {
      const defaultCapabilities =
          entry.name === "gmail" ? "read,search,send" : "send",
        capabilities =
          (
            await rl.question(`Capabilities [${defaultCapabilities}]: `)
          ).trim() || defaultCapabilities;
      args.push("--capabilities", capabilities);
      if (entry.name === "gmail")
        args.push(
          "--account",
          await rl.question("Account email: "),
          "--client-id",
          await rl.question("OAuth client ID: "),
        );
      else
        args.push(
          "--domain",
          await rl.question("Mailgun domain: "),
          "--from",
          await rl.question("From address: "),
        );
      if (capabilities.split(",").includes("send"))
        args.push(
          "--allowed-recipients",
          await rl.question("Allowed recipients (comma-separated): "),
        );
    }
    if (entry.kind === "host-repo" || entry.kind === "host-store") {
      args.push(
        "--path",
        await rl.question(
          "Host path (absolute or relative to current directory): ",
        ),
        "--mount",
        await rl.question("Pi mount path (absolute or relative to /home/pi): "),
      );
      if (entry.kind === "host-repo") {
        const branch = (
          await rl.question("Canonical branch [symbolic HEAD]: ")
        ).trim();
        if (branch) args.push("--branch", branch);
      }
    }
    return await explicitConnection(args);
  } finally {
    rl.close();
  }
}
async function readCredential(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const rl = createInterface({ input, output });
    try {
      const value = (await rl.question("")).trim();
      if (!value) throw new IntegralError("credential must not be empty");
      return value;
    } finally {
      rl.close();
    }
  }
  if (!input.isTTY)
    throw new IntegralError(
      "credential input requires a terminal or --credential-stdin",
    );
  process.stdout.write("Credential (hidden; stored outside configuration): ");
  const value = await new Promise<string>((resolve, reject) => {
    let text = "";
    input.setRawMode(true);
    input.resume();
    const data = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new IntegralError("credential entry cancelled"));
          return;
        }
        if (byte === 10 || byte === 13) {
          cleanup();
          process.stdout.write("\n");
          resolve(text);
          return;
        }
        if (byte === 127 || byte === 8) text = text.slice(0, -1);
        else if (byte >= 32) text += String.fromCharCode(byte);
      }
    };
    const cleanup = () => {
      input.off("data", data);
      input.setRawMode(false);
      input.pause();
    };
    input.on("data", data);
  });
  if (!value.trim()) throw new IntegralError("credential must not be empty");
  return value.trim();
}
async function readStdioCredentials(
  names: string[],
  fromStdin: boolean,
): Promise<string> {
  const values: Record<string, string> = {};
  if (fromStdin) {
    const rl = createInterface({ input, output });
    try {
      for (const name of names) {
        const value = (await rl.question("")).trim();
        if (!value)
          throw new IntegralError(`credential for ${name} must not be empty`);
        values[name] = value;
      }
    } finally {
      rl.close();
    }
  } else {
    for (const name of names) {
      process.stdout.write(`${name} (hidden; stored outside configuration): `);
      values[name] = await readCredential(false);
    }
  }
  return JSON.stringify({ type: "stdio-env", values });
}
async function authenticateOAuth(
  paths: IntegralPaths,
  connection: Connection,
): Promise<string> {
  if (!input.isTTY)
    throw new IntegralError("OAuth setup requires an interactive terminal");
  const rl = createInterface({ input, output });
  const ui = {
    show: (message: string) => process.stdout.write(`${message}\n`),
    prompt: (message: string, signal?: AbortSignal) =>
      signal ? rl.question(message, { signal }) : rl.question(message),
  };
  try {
    return connection.kind === "model"
      ? await runModelOAuth(
          paths,
          connection.provider!,
          connection.auth as "oauth" | "device-code",
          ui,
        )
      : await runGenericOAuth(connection, ui);
  } finally {
    rl.close();
  }
}
async function verifySetup(
  connection: Connection,
  credential?: string,
): Promise<void> {
  const url =
    connection.provider === "github"
      ? "https://api.github.com/user"
      : connection.url;
  if (!url) return;
  const headers: Record<string, string> = {},
    effective = credential
      ? (oauthAccess(credential) ?? credential)
      : undefined;
  if (connection.provider === "github" && effective)
    headers.Authorization = `token ${effective}`;
  else if (connection.auth !== "none")
    headers[connection.header ?? "Authorization"] =
      `${connection.scheme ?? "Bearer"} ${effective}`;
  const response = await fetch(url, {
    method: connection.provider === "github" ? "GET" : "HEAD",
    headers,
  });
  if (!response.ok)
    throw new IntegralError(
      `connection verification failed: HTTP ${response.status}`,
    );
}
async function confirm(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<boolean> {
  return /^(y|yes)$/i.test((await rl.question(question)).trim());
}

async function serverCommand(args: string[]): Promise<number> {
  const command = args[0];
  if (!command || helpRequested(args) || command === "help") {
    process.stdout.write(SERVER_HELP);
    return 0;
  }
  const paths = resolvePaths();
  if (command === "status") {
    const status = await serverStatus(paths);
    if (has(args, "--json")) writeJson(status);
    else {
      process.stdout.write(`deployment: ${status.overall}\n`);
      for (const component of COMPONENTS)
        process.stdout.write(
          `${component}: ${status.components[component].status}${status.components[component].endpoint ? ` (${status.components[component].endpoint})` : ""}\n`,
        );
    }
    return status.overall === "healthy" ? 0 : 1;
  }
  if (command === "start") {
    const selected = flag(args, "--component");
    if (selected && !COMPONENTS.includes(selected as Component))
      throw new IntegralError(`invalid component: ${selected}`);
    const config = await loadConfig(paths);
    await startComponents(paths, config, selected as Component | undefined);
    return 0;
  }
  throw new IntegralError(`unknown server command: ${command}`);
}

export interface ScheduleDependencies {
  resolvePaths(): IntegralPaths;
  componentEndpoint: typeof componentEndpoint;
  verifiedFetch: typeof verifiedFetch;
  fetch: typeof globalThis.fetch;
  writeOutput(text: string): void;
}

const productionScheduleDependencies: ScheduleDependencies = {
  resolvePaths,
  componentEndpoint,
  verifiedFetch,
  fetch: globalThis.fetch,
  writeOutput: (text) => process.stdout.write(text),
};

export async function scheduleCommand(
  args: string[],
  overrides: Partial<ScheduleDependencies> = {},
): Promise<number> {
  const dependencies = { ...productionScheduleDependencies, ...overrides };
  if (!args[0] || helpRequested(args) || args[0] === "help") {
    dependencies.writeOutput(SCHEDULE_HELP);
    return 0;
  }
  const paths = dependencies.resolvePaths(),
    scheduler = await dependencies.componentEndpoint(paths, "scheduler");
  await dependencies
    .verifiedFetch(paths, "scheduler", "/integral/health")
    .catch(() => {
      throw new IntegralError(
        "scheduler is not reachable; start it with integral server start",
      );
    });
  const command = args[0],
    jsonOutput = has(args, "--json");
  if (command === "ls") {
    const value = await fetchJson(
      new URL("/integral/schedules", scheduler),
      dependencies.fetch,
    );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  if (command === "show" || command === "history") {
    const id = args[1];
    if (!id)
      throw new IntegralError(`usage: integral schedule ${command} <id>`);
    const suffix = command === "history" ? "/history" : "",
      value = await fetchJson(
        new URL(
          `/integral/schedules/${encodeURIComponent(id)}${suffix}`,
          scheduler,
        ),
        dependencies.fetch,
      );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  if (command === "runs") {
    const url = new URL("/integral/occurrences", scheduler),
      scheduleId = args[1];
    if (scheduleId && !scheduleId.startsWith("--"))
      url.searchParams.set("scheduleId", scheduleId);
    const value = await fetchJson(url, dependencies.fetch);
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  if (command === "cancel") {
    const executionId = args[1];
    if (!executionId)
      throw new IntegralError("usage: integral schedule cancel <execution-id>");
    const coordinator = await dependencies.componentEndpoint(
        paths,
        "coordinator",
      ),
      value = await requestJson(
        new URL(
          `/integral/tasks/${encodeURIComponent(executionId)}/cancel`,
          coordinator,
        ),
        { method: "POST", body: "{}" },
        dependencies.fetch,
      );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  const actor = "operator";
  if (command === "create") {
    const prompt = flag(args, "--prompt");
    if (!prompt)
      throw new IntegralError("schedule create requires --prompt <text>");
    const coordinator = await dependencies.componentEndpoint(
        paths,
        "coordinator",
      ),
      snapshot = (await fetchJson(
        new URL("/integral/snapshot", coordinator),
        dependencies.fetch,
      )) as { modelSelection?: ModelSelection | null };
    if (!snapshot.modelSelection)
      throw new IntegralError("select a model before creating a schedule");
    const value = await requestJson(
      new URL("/integral/schedules", scheduler),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor,
          prompt,
          trigger: scheduleTriggerFromFlags(args),
          profile: snapshot.modelSelection,
        }),
      },
      dependencies.fetch,
    );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  if (["update", "enable", "disable", "delete", "restore"].includes(command)) {
    const id = args[1],
      revision = Number(flag(args, "--revision"));
    if (!id || !Number.isInteger(revision) || revision < 1)
      throw new IntegralError(
        `integral schedule ${command} requires <id> --revision <n>`,
      );
    let path = `/integral/schedules/${encodeURIComponent(id)}`,
      method = "POST";
    const body: Record<string, unknown> = { actor, expectedRevision: revision };
    if (command === "update") {
      method = "PATCH";
      const prompt = flag(args, "--prompt");
      if (prompt) body.prompt = prompt;
      if (flag(args, "--at") || flag(args, "--cron"))
        body.trigger = scheduleTriggerFromFlags(args);
    } else if (command === "delete") method = "DELETE";
    else {
      path += `/${command}`;
      if (command === "restore") {
        const commit = args[2];
        if (!commit)
          throw new IntegralError(
            "usage: integral schedule restore <id> <commit> --revision <n>",
          );
        body.commit = commit;
      }
    }
    const value = await requestJson(
      new URL(path, scheduler),
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      dependencies.fetch,
    );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  throw new IntegralError(`unknown schedule command: ${command}`);
}

function scheduleTriggerFromFlags(args: string[]): Record<string, string> {
  const runAt = flag(args, "--at"),
    cron = flag(args, "--cron"),
    timezone = flag(args, "--timezone");
  if (runAt && !cron && !timezone) return { type: "once", runAt };
  if (!runAt && cron && timezone) return { type: "recurring", cron, timezone };
  throw new IntegralError(
    "provide either --at <instant> or both --cron <expression> and --timezone <zone>",
  );
}

function renderScheduleValue(
  value: unknown,
  jsonOutput: boolean,
  write: (text: string) => void,
): void {
  if (jsonOutput) {
    write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      write(`${String(row)}\n`);
      continue;
    }
    const item = row as Record<string, unknown>;
    write(
      [
        item.state ??
          (item.deleted
            ? "deleted"
            : item.enabled === false
              ? "disabled"
              : "enabled"),
        item.id ?? item.scheduleId ?? item.executionId ?? item.commit,
        item.revision ?? item.scheduledFor ?? item.operation ?? "",
        item.prompt ?? item.error ?? "",
      ]
        .filter((part) => part !== undefined && part !== "")
        .join("\t") + "\n",
    );
  }
}

export interface TalkTerminal {
  question(prompt: string): Promise<string>;
  writeEvent?(text: string): void;
  setWorking?(working: boolean): void;
  colors?: boolean;
  close(): void;
}

export interface TalkDependencies {
  resolvePaths(): IntegralPaths;
  componentEndpoint: typeof componentEndpoint;
  verifiedFetch: typeof verifiedFetch;
  fetch: typeof globalThis.fetch;
  createTerminal(): TalkTerminal;
  createTerminalId(): string;
  writeOutput(text: string): void;
  writeError(text: string): void;
}

const productionTalkDependencies: TalkDependencies = {
  resolvePaths,
  componentEndpoint,
  verifiedFetch,
  fetch: globalThis.fetch,
  createTerminal: createTalkTerminal,
  createTerminalId: randomUUID,
  writeOutput: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
};

interface TalkReadline {
  readonly line: string;
  readonly cursor: number;
  question(prompt: string): Promise<string>;
  close(): void;
}

interface TalkOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

interface TalkTerminalControls {
  clearLine(destination: TalkOutput): void;
  cursorTo(destination: TalkOutput): void;
  moveCursor(
    destination: TalkOutput,
    horizontal: number,
    vertical?: number,
  ): void;
}

interface TalkTerminalClock {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export function createTalkTerminal(overrides?: {
  terminal: TalkReadline;
  output: TalkOutput;
  controls: TalkTerminalControls;
  clock?: TalkTerminalClock;
}): TalkTerminal {
  const destination = overrides?.output ?? output,
    terminal =
      overrides?.terminal ??
      createInterface({
        input,
        output,
        terminal: Boolean(input.isTTY),
      }),
    controls = overrides?.controls ?? {
      clearLine: (stream: TalkOutput) =>
        clearLine(stream as NodeJS.WriteStream, 0),
      cursorTo: (stream: TalkOutput) =>
        cursorTo(stream as NodeJS.WriteStream, 0),
      moveCursor: (stream: TalkOutput, horizontal: number, vertical = 0) =>
        moveCursor(stream as NodeJS.WriteStream, horizontal, vertical),
    },
    clock = overrides?.clock ?? {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
  let activePrompt: string | undefined,
    working = false,
    frame = 0,
    animation: unknown;
  const displayedPrompt = () =>
      `${working ? `${TALK_WORK_FRAMES[frame]}\n` : ""}${activePrompt ?? ""}`,
    clearDisplayedPrompt = (hasWorkingLine: boolean) => {
      controls.clearLine(destination);
      controls.cursorTo(destination);
      if (hasWorkingLine) {
        controls.moveCursor(destination, 0, -1);
        controls.clearLine(destination);
        controls.cursorTo(destination);
      }
    },
    redrawPrompt = (hadWorkingLine: boolean) => {
      if (!activePrompt || !destination.isTTY) return;
      const pendingInput = terminal.line,
        pendingCursor = terminal.cursor;
      if (activePrompt === humanLabel(true))
        destination.write(TALK_STYLE_RESET);
      clearDisplayedPrompt(hadWorkingLine);
      destination.write(`${displayedPrompt()}${pendingInput}`);
      if (pendingCursor < pendingInput.length)
        controls.moveCursor(destination, pendingCursor - pendingInput.length);
    };
  return {
    colors: Boolean(destination.isTTY) && process.env.NO_COLOR === undefined,
    async question(prompt) {
      activePrompt = prompt;
      try {
        return await terminal.question(displayedPrompt());
      } finally {
        if (prompt === humanLabel(true)) destination.write(TALK_STYLE_RESET);
        activePrompt = undefined;
      }
    },
    writeEvent(text) {
      if (!activePrompt || !destination.isTTY) {
        destination.write(text);
        return;
      }
      const pendingInput = terminal.line,
        pendingCursor = terminal.cursor;
      if (activePrompt === humanLabel(true))
        destination.write(TALK_STYLE_RESET);
      clearDisplayedPrompt(working);
      destination.write(text);
      destination.write(`${displayedPrompt()}${pendingInput}`);
      if (pendingCursor < pendingInput.length)
        controls.moveCursor(destination, pendingCursor - pendingInput.length);
    },
    setWorking(next) {
      if (working === next || !destination.isTTY) return;
      const hadWorkingLine = working;
      working = next;
      frame = 0;
      if (animation !== undefined) clock.clearInterval(animation);
      animation = undefined;
      redrawPrompt(hadWorkingLine);
      if (working)
        animation = clock.setInterval(() => {
          frame = (frame + 1) % TALK_WORK_FRAMES.length;
          redrawPrompt(true);
        }, 160);
    },
    close() {
      if (animation !== undefined) clock.clearInterval(animation);
      terminal.close();
    },
  };
}

export async function talkCommand(
  args: string[],
  overrides: Partial<TalkDependencies> = {},
): Promise<number> {
  const dependencies = { ...productionTalkDependencies, ...overrides };
  if (helpRequested(args)) {
    dependencies.writeOutput(
      `Usage: integral talk [<pattern>...]\n\nAttach this terminal to the one durable deployment conversation. Optional patterns search connection, provider, and model names.\n${TALK_HELP}`,
    );
    return 0;
  }
  const paths = dependencies.resolvePaths();
  let endpoint: string;
  try {
    endpoint = await dependencies.componentEndpoint(paths, "coordinator");
    await dependencies.verifiedFetch(paths, "coordinator", "/integral/health");
  } catch {
    throw new IntegralError(
      "coordinator is not reachable; start it with integral server start",
    );
  }
  const abort = new AbortController();
  const rl = dependencies.createTerminal(),
    terminalId = dependencies.createTerminalId();
  let follow: Promise<void> | undefined;
  try {
    await chooseConversationModel(
      args,
      rl,
      endpoint,
      dependencies.fetch,
      dependencies.writeOutput,
      args.length === 0,
    );
    const response = await dependencies.fetch(
      new URL("/integral/events", endpoint),
      {
        signal: abort.signal,
      },
    );
    if (!response.ok || !response.body)
      throw new IntegralError("could not attach to coordinator");
    let attachmentId = response.headers.get("x-integral-attachment-id");
    if (!attachmentId)
      throw new IntegralError(
        "coordinator did not issue a terminal attachment identity",
      );
    follow = followCoordinatorEvents(
      response,
      paths,
      dependencies,
      abort.signal,
      rl.writeEvent?.bind(rl) ?? dependencies.writeOutput,
      terminalId,
      Boolean(rl.colors),
      (working) => rl.setWorking?.(working),
      (next, nextAttachmentId) => {
        endpoint = next;
        attachmentId = nextAttachmentId;
      },
    );
    while (true) {
      let line: string;
      try {
        line = await rl.question(humanLabel(Boolean(rl.colors)));
      } catch {
        break;
      }
      const text = line.trim();
      if (!text) continue;
      if (text === "/exit") break;
      try {
        if (text === "/help") {
          dependencies.writeOutput(TALK_HELP);
          continue;
        }
        if (text === "/status") {
          const status = await fetchJson(
            new URL("/integral/status", endpoint),
            dependencies.fetch,
          );
          dependencies.writeOutput(`${JSON.stringify(status, null, 2)}\n`);
          continue;
        }
        const model = text.match(/^\/model(?:\s+(.*))?$/);
        if (model) {
          await chooseConversationModel(
            model[1]?.trim().split(/\s+/).filter(Boolean) ?? [],
            rl,
            endpoint,
            dependencies.fetch,
            dependencies.writeOutput,
          );
          continue;
        }
        if (text === "/queue ls") {
          const snap = (await fetchJson(
            new URL("/integral/snapshot", endpoint),
            dependencies.fetch,
          )) as {
            queue: { id: string; text: string; status: string }[];
          };
          for (const item of snap.queue)
            dependencies.writeOutput(
              `${item.status}\t${item.id}\t${item.text}\n`,
            );
          continue;
        }
        if (text === "/approvals") {
          const approvals = (await fetchJson(
            new URL("/integral/approvals", endpoint),
            dependencies.fetch,
          )) as Array<Record<string, unknown>>;
          if (!approvals.length)
            dependencies.writeOutput("No approval requests.\n");
          else
            for (const approval of approvals)
              dependencies.writeOutput(`${renderApproval(approval)}\n`);
          continue;
        }
        const approvalDecision = text.match(/^\/(approve|deny)\s+(\S+)$/);
        if (approvalDecision) {
          const result = (await fetchJson(
            new URL(
              `/integral/approvals/${encodeURIComponent(approvalDecision[2]!)}/${approvalDecision[1]}`,
              endpoint,
            ),
            dependencies.fetch,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ attachmentId }),
            },
          )) as Record<string, unknown>;
          dependencies.writeOutput(`${renderApproval(result)}\n`);
          continue;
        }
        const edit = text.match(/^\/queue edit\s+(\S+)\s+(.+)$/);
        if (edit) {
          await requestOk(
            new URL(`/integral/queue/${edit[1]}`, endpoint),
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: edit[2] }),
            },
            dependencies.fetch,
          );
          continue;
        }
        const del = text.match(/^\/queue delete\s+(\S+)$/);
        if (del) {
          await requestOk(
            new URL(`/integral/queue/${del[1]}`, endpoint),
            { method: "DELETE" },
            dependencies.fetch,
          );
          continue;
        }
        if (text.startsWith("/")) {
          dependencies.writeError("Unknown local command. Enter /help.\n");
          continue;
        }
        await requestOk(
          new URL("/integral/messages", endpoint),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, terminalId }),
          },
          dependencies.fetch,
        );
      } catch (error) {
        dependencies.writeError(`integral: ${messageOf(error)}\n`);
      }
    }
    return 0;
  } finally {
    rl.setWorking?.(false);
    rl.close();
    abort.abort();
    await follow;
  }
}

interface ModelMenu {
  choices: ModelChoice[];
  current: ModelSelection | null;
  piVersion?: string;
  warning?: string;
}

async function chooseConversationModel(
  initialTerms: readonly string[],
  terminal: TalkTerminal,
  endpoint: string,
  fetcher: typeof globalThis.fetch,
  writeOutput: (text: string) => void,
  reuseCurrent = false,
): Promise<ModelChoice> {
  const menu = (await fetchJson(
    new URL("/integral/models", endpoint),
    fetcher,
  )) as ModelMenu;
  if (menu.warning) writeOutput(`Warning: ${menu.warning}\n`);
  if (!menu.choices.length)
    throw new IntegralError(
      "no provider and model choices are available; run integral connection add",
    );
  const current = menu.choices.find((choice) =>
    sameModel(menu.current ?? undefined, choice),
  );
  if (menu.current && !current)
    writeOutput(
      `Previous model ${menu.current.connection} (${menu.current.provider}) / ${menu.current.model} is no longer available.\n`,
    );
  if (reuseCurrent && current) {
    if (!sameSelection(menu.current ?? undefined, current))
      await saveConversationSelection(current, endpoint, fetcher);
    return current;
  }
  let displayed = menu.choices,
    pendingTerms = [...initialTerms];
  while (true) {
    renderModelChoices(displayed, current, menu.piVersion, writeOutput);
    const raw = pendingTerms.length
      ? pendingTerms.join(" ")
      : (
          await terminal.question(current ? "Model [current]: " : "Model: ")
        ).trim();
    pendingTerms = [];
    if (!raw && current) {
      if (!sameSelection(menu.current ?? undefined, current))
        await saveConversationSelection(current, endpoint, fetcher);
      return current;
    }
    if (!raw) {
      writeOutput("Select a model by number or search terms.\n");
      displayed = menu.choices;
      continue;
    }
    const number = /^\d+$/.test(raw) ? Number(raw) : undefined;
    let matches: ModelChoice[];
    if (number !== undefined) {
      const choice = displayed[number - 1];
      matches = choice ? [choice] : [];
    } else matches = matchModelChoices(displayed, raw.split(/\s+/));
    if (matches.length === 1) {
      const selected = matches[0]!;
      if (!sameSelection(menu.current ?? undefined, selected))
        await saveConversationSelection(selected, endpoint, fetcher);
      writeOutput(
        `Selected ${selected.connection} (${selected.provider}) / ${selected.model}\n`,
      );
      return selected;
    }
    if (matches.length > 1) {
      writeOutput(
        "Multiple models match; narrow the search or choose a number.\n",
      );
      displayed = matches;
    } else {
      writeOutput("No provider and model match; showing all choices.\n");
      displayed = menu.choices;
    }
  }
}

async function saveConversationSelection(
  selected: ModelChoice,
  endpoint: string,
  fetcher: typeof globalThis.fetch,
): Promise<void> {
  await requestOk(
    new URL("/integral/selection", endpoint),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection: selected.connection,
        model: selected.model,
      }),
    },
    fetcher,
  );
}

function renderModelChoices(
  choices: readonly ModelChoice[],
  current: ModelSelection | undefined,
  piVersion: string | undefined,
  writeOutput: (text: string) => void,
): void {
  const lines = [`Available models${piVersion ? ` (Pi ${piVersion})` : ""}:`];
  let prior = "";
  choices.forEach((choice, index) => {
    const group = `${choice.connection}\u0000${choice.provider}`;
    if (group !== prior) {
      lines.push(`${choice.connection} (${choice.provider})`);
      prior = group;
    }
    lines.push(
      `  ${index + 1}. ${choice.model}${sameSelection(current, choice) ? " [current]" : ""}`,
    );
  });
  lines.push(
    "Enter a number or case-insensitive search terms.",
    "Search directly with: integral talk <pattern>... or /model <pattern>...",
    "",
  );
  writeOutput(lines.join("\n"));
}

interface TalkEventState {
  sawSnapshot: boolean;
  lastConversationSequence: number;
}

async function followCoordinatorEvents(
  initialResponse: Response,
  paths: IntegralPaths,
  dependencies: TalkDependencies,
  signal: AbortSignal,
  writeOutput: (text: string) => void,
  terminalId: string,
  colors: boolean,
  setWorking: (working: boolean) => void,
  connected: (endpoint: string, attachmentId: string) => void,
): Promise<void> {
  const state: TalkEventState = {
    sawSnapshot: false,
    lastConversationSequence: 0,
  };
  let response: Response | undefined = initialResponse,
    reconnecting = false;
  while (!signal.aborted) {
    try {
      if (!response) {
        const endpoint = await dependencies.componentEndpoint(
          paths,
          "coordinator",
        );
        await dependencies.verifiedFetch(
          paths,
          "coordinator",
          "/integral/health",
        );
        response = await dependencies.fetch(
          new URL("/integral/events", endpoint),
          { signal },
        );
        if (!response.ok || !response.body)
          throw new IntegralError("could not attach to coordinator");
        const attachmentId = response.headers.get("x-integral-attachment-id");
        if (!attachmentId)
          throw new IntegralError(
            "coordinator did not issue a terminal attachment identity",
          );
        connected(endpoint, attachmentId);
        if (reconnecting) writeOutput("integral: coordinator reconnected\n");
      }
      await consumeEvents(
        response.body!,
        writeOutput,
        terminalId,
        colors,
        setWorking,
        state,
      );
      if (signal.aborted) return;
      throw new IntegralError("coordinator event stream ended");
    } catch {
      if (signal.aborted) return;
      setWorking(false);
      if (!reconnecting)
        dependencies.writeError(
          "integral: coordinator disconnected; reconnecting\n",
        );
      reconnecting = true;
      response = undefined;
      await reconnectDelay(signal);
    }
  }
}

async function reconnectDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 500);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function consumeEvents(
  stream: ReadableStream<Uint8Array>,
  writeOutput: (text: string) => void = (text) => process.stdout.write(text),
  terminalId?: string,
  colors = false,
  setWorking: (working: boolean) => void = () => undefined,
  state: TalkEventState = {
    sawSnapshot: false,
    lastConversationSequence: 0,
  },
): Promise<void> {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    sessionActive = false,
    inFlight = false,
    working = false;
  const updateWorking = () => {
    const next = sessionActive && inFlight;
    if (next === working) return;
    working = next;
    setWorking(working);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = block.match(/^event: (.+)$/m)?.[1],
        data = block.match(/^data: (.+)$/m)?.[1];
      if (!data) continue;
      const value = JSON.parse(data) as Record<string, unknown>;
      if (event === "snapshot") {
        const snapshot = value as {
          conversation: { type: string; text?: string; sequence?: number }[];
          queue?: { status: string }[];
          approvals?: Array<Record<string, unknown>>;
        };
        const latestSession = snapshot.conversation
          .filter((item) => item.type === "session")
          .at(-1);
        sessionActive = latestSession?.text === "started";
        inFlight =
          snapshot.queue?.some((item) => item.status === "in-flight") ?? false;
        updateWorking();
        const firstSnapshot = !state.sawSnapshot;
        for (const item of snapshot.conversation) {
          const unseen =
            firstSnapshot ||
            (typeof item.sequence === "number" &&
              item.sequence > state.lastConversationSequence);
          if (typeof item.sequence === "number")
            state.lastConversationSequence = Math.max(
              state.lastConversationSequence,
              item.sequence,
            );
          if (unseen && item.text && item.type !== "session") {
            writeOutput(
              item.type === "user"
                ? humanMessage(item.text, colors)
                : `∮ ${item.text}\n`,
            );
          }
        }
        state.sawSnapshot = true;
        if (firstSnapshot)
          for (const approval of snapshot.approvals ?? [])
            if (approval.status === "pending")
              writeOutput(`${renderApproval(approval)}\n`);
      } else if (event === "conversation.user") {
        const item = value as {
          type: string;
          text?: string;
          terminalId?: string;
          sequence?: number;
        };
        if (typeof item.sequence === "number")
          state.lastConversationSequence = Math.max(
            state.lastConversationSequence,
            item.sequence,
          );
        if (item.text && item.terminalId !== terminalId)
          writeOutput(humanMessage(item.text, colors));
      } else if (
        event === "conversation.assistant" ||
        event === "conversation.error"
      ) {
        const item = value as {
          type: string;
          text?: string;
          sequence?: number;
        };
        if (typeof item.sequence === "number")
          state.lastConversationSequence = Math.max(
            state.lastConversationSequence,
            item.sequence,
          );
        inFlight = false;
        updateWorking();
        if (item.text) writeOutput(`∮ ${item.text}\n`);
      } else if (event === "queue.claimed") {
        inFlight = true;
        updateWorking();
      } else if (event === "queue.completed" || event === "queue.released") {
        inFlight = false;
        updateWorking();
      } else if (event === "queue.edited") {
        const item = (value as { message: { id: string; text: string } })
          .message;
        writeOutput(`queue: edited ${item.id} ${item.text}\n`);
      } else if (event === "queue.deleted")
        writeOutput(
          `queue: deleted ${(value as { messageId: string }).messageId}\n`,
        );
      else if (event === "conversation.session") {
        const item = value as { sessionId?: string; text?: string };
        sessionActive = item.text === "started";
        updateWorking();
        writeOutput(`session: ${item.text} ${item.sessionId}\n`);
      } else if (event === "conversation.selection") {
        const item = value as unknown as ModelSelection;
        writeOutput(
          `model: ${item.connection} (${item.provider}) / ${item.model}\n`,
        );
      } else if (
        event === "approval.requested" ||
        event === "approval.decided" ||
        event === "approval.resolved"
      ) {
        writeOutput(`${renderApproval(value)}\n`);
      }
    }
  }
}

function renderApproval(value: Record<string, unknown>): string {
  const id = typeof value.id === "string" ? value.id : "unknown",
    status = typeof value.status === "string" ? value.status : "unknown",
    summary = typeof value.summary === "string" ? value.summary : "request",
    details =
      value.details && typeof value.details === "object"
        ? (value.details as Record<string, unknown>)
        : undefined,
    diff = typeof details?.diff === "string" ? details.diff.trim() : "";
  const floating = details?.floatingResolution === true,
    priorImage =
      typeof details?.priorImage === "string" ? details.priorImage : "unknown";
  return `approval ${id} [${status}] ${summary}${floating ? `\nFloating dependencies will resolve at build time; prior image: ${priorImage}` : ""}${diff ? `\n${diff}` : ""}`;
}

function humanLabel(colors: boolean): string {
  return colors ? `${TALK_USER_STYLE} ☺ ` : "☺ ";
}

function humanMessage(text: string, colors: boolean): string {
  return colors
    ? `${humanLabel(true)}${text} ${TALK_STYLE_RESET}\n`
    : `${humanLabel(false)}${text}\n`;
}
