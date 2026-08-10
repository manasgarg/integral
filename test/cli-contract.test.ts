import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  completeEmailOptions,
  createTalkTerminal,
  explicitConnection,
  imageCommand,
  main,
  queueCommand,
  selectAuthentication,
  talkCommand,
} from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { fixture } from "./helpers.ts";
import { saveConnection, validateConnection } from "../src/connections.ts";
import { addHostResource, softDeleteResource } from "../src/resources.ts";

async function capture(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "",
    stderr = "";
  const out = process.stdout.write,
    err = process.stderr.write,
    original = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete process.env[key];
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    return { code: await main(args), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

/* @covers ENV-0E6A92C4
Given `INTEGRAL_HOME` and `HOME` are invalid or unavailable
	When the user runs `integral --help`
		Then the command succeeds without resolving a deployment root
	When the user runs `integral version`
		Then the command succeeds without resolving a deployment root
	When the user runs `integral connection catalog`
		Then the command succeeds without resolving a deployment root
*/
test("[ENV-0E6A92C4] help, version, and catalog do not resolve invalid deployment state", async () => {
  for (const args of [["--help"], ["version"], ["connection", "catalog"]]) {
    const result = await capture(args, {
      INTEGRAL_HOME: "relative",
      HOME: undefined,
    });
    assert.equal(result.code, 0, result.stderr);
  }
});

/* @covers CLI-A7D3E91B
Given integral is installed
	When the user adds `-h` to any integral command or subcommand
		Then integral prints the applicable help
			And exits successfully
			And does not perform the command operation
*/
test("[CLI-A7D3E91B] -h prints applicable help at every command depth without performing the operation", async () => {
  for (const args of [
    ["-h"],
    ["version", "-h"],
    ["config", "-h"],
    ["config", "show", "-h"],
    ["connection", "-h"],
    ["connection", "add", "-h"],
    ["server", "-h"],
    ["server", "start", "-h"],
    ["queue", "-h"],
    ["queue", "ls", "-h"],
    ["talk", "-h"],
  ]) {
    const result = await capture(args, {
      INTEGRAL_HOME: "relative",
      HOME: undefined,
    });
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/, args.join(" "));
    assert.equal(result.stderr, "", args.join(" "));
  }
});

/* @covers CONNECTION-C14B8E70
Given integral is installed
	When the user runs `integral connection --help`
		Then the command lists `catalog`, `add`, `ls`, and `rm`
			And describes bare `add` as guided setup
			And documents `--auth` for explicit setup
			And documents `--transport`, `--command`, `--arg`, `--env`, `--secret-env`, and `--allow-url` for MCP setup
			And documents `--path`, `--branch`, and `--mount` for host resources
			And does not list `grant` or `revoke`
*/
test("[CONNECTION-C14B8E70] connection help lists catalog, guided add, list, and removal but no grants", async () => {
  const result = await capture(["connection", "--help"]);
  assert.equal(result.code, 0);
  for (const command of ["catalog", "add", "ls", "rm"])
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  assert.match(result.stdout, /guided setup/);
  assert.match(result.stdout, /--auth <method>/);
  for (const option of [
    "--transport",
    "--command",
    "--arg",
    "--env",
    "--secret-env",
    "--allow-url",
  ])
    assert.match(result.stdout, new RegExp(option));
  assert.doesNotMatch(result.stdout, /^\s+(grant|revoke)\b/m);
});

/* @covers CONNECTION-75EC27E8
Given integral is installed
	When the user runs `integral connection catalog`
		Then the command lists `openai-codex` and `anthropic`
			And lists `gmail` and `mailgun` email providers
			And lists generic `http` and `mcp` connection types
			And lists the `host-repo` connection type
			And lists the `host-store` connection type
			And identifies the kind of each catalog entry
			And describes supported OAuth, device-code, key, and no-auth methods
			And does not list channel or general host-directory connection types
*/
test("[CONNECTION-75EC27E8] catalog describes model, email, HTTP, MCP and every supported authentication family", async () => {
  const result = await capture(["connection", "catalog"]);
  for (const word of [
    "openai-codex",
    "anthropic",
    "github",
    "http",
    "mcp",
    "gmail",
    "mailgun",
    "email",
    "model",
    "oauth",
    "device-code",
    "key",
    "none",
  ])
    assert.match(result.stdout, new RegExp(word));
});

/* @covers CONNECTION-A61E2C9D
Given the user has an HTTP or HTTPS endpoint
	When the user runs `integral connection add http --name <name> --url <url>`
		And completes the selected authentication setup
		Then integral records the normalized scheme, host, port, and path prefix
			And makes the named endpoint available to Pi
			And configures the gateway to allow only that endpoint boundary
			And injects its credential only inside that boundary when authentication requires it
*/
/* @covers CONNECTION-E73B40C6
Given a no-auth HTTP or MCP connection with no stored secret environment values exists
	And the terminal is interactive
	When the user runs `integral connection rm <name>`
		Then integral describes the connection record to be removed
			And asks for confirmation before removing it
	When the user declines confirmation
		Then integral leaves the connection unchanged
	When the user confirms removal
		Then integral removes the connection record
			And prevents new chats from selecting the removed connection
*/
test("[CONNECTION-A61E2C9D] [CONNECTION-E73B40C6] explicit no-auth HTTP setup and listing work end-to-end", async (t) => {
  const paths = await fixture(t),
    env = { INTEGRAL_HOME: paths.root };
  const add = await capture(
    [
      "connection",
      "add",
      "http",
      "--name",
      "public",
      "--url",
      "https://example.test/api",
      "--auth",
      "none",
    ],
    env,
  );
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /Added public/);
  const ls = await capture(["connection", "ls", "--json"], env);
  const rows = JSON.parse(ls.stdout);
  assert.deepEqual(rows, [
    {
      name: "public",
      kind: "http",
      provider: null,
      auth: "none",
      state: "active",
    },
  ]);
});

/* @covers CONNECTION-12C87631
Given no GitHub connection exists
	When the user runs `integral connection add github --auth key`
		And supplies a non-empty personal access token
		Then integral stores one connection for `api.github.com` and `github.com`
			And stores the token only in the host credential area
			And identifies GitHub as an HTTP connection in the catalog and connection list
Given an active GitHub connection exists
	And a Pi session provisioned before that connection is still active
	When integral observes the new connection generation
		Then integral ends the stale Pi session before the next turn
			And provisions the replacement with GitHub access
Given an active GitHub connection exists
	When integral provisions a Pi container
		Then the container includes `git` and `gh`
			And receives `GH_TOKEN` set to the integral credential sentinel
			And does not receive the real GitHub token
	When Pi calls the GitHub API over HTTPS
		Then the gateway allows the request only on `api.github.com`
			And injects the stored token using GitHub API authentication
	When Pi uses Git smart HTTP over HTTPS
		Then the gateway allows the request only on `github.com`
			And injects the stored token using GitHub Basic authentication
	When Pi attempts GitHub access through SSH or another host
		Then the gateway denies the request
*/
test("[CONNECTION-12C87631] explicit GitHub setup stores one automatically bounded connection", async (t) => {
  const paths = await fixture(t),
    connection = await explicitConnection(["github", "--auth", "key"]);
  assert.equal(connection.provider, "github");
  assert.deepEqual(connection.hosts, ["api.github.com", "github.com"]);
  await saveConnection(paths, connection, "github-secret");
  const listed = await capture(["connection", "ls", "--json"], {
    INTEGRAL_HOME: paths.root,
  });
  assert.deepEqual(JSON.parse(listed.stdout), [
    {
      name: "github",
      kind: "http",
      provider: "github",
      auth: "key",
      state: "active",
    },
  ]);
});

/* @covers CONNECTION-0EF2CF89
Given the user has an MCP server executable available in the configured runner image
	When the user runs `integral connection add mcp --transport stdio --name <name> --command <executable>`
		And supplies zero or more `--arg <argument>` values
		Then integral records the executable and each argument without shell parsing or expansion
			And treats the argument following `--command` as the exact executable name or absolute image path
			And uses the arguments in their supplied order
			And runs setup verification in a short-lived isolated sidecar using the configured runner image
			And negotiates a supported MCP protocol over standard input and standard output
			And discovers every available tool before committing the connection
			And stores the connection only after discovery succeeds
			And reports the server name, stdio transport, protocol, and tool count
	When the user supplies `--env <name>=<value>`
		Then integral stores and supplies the value as non-secret sidecar configuration
	When the user supplies `--secret-env <name>`
		Then integral reads the named value without echoing it
			And stores it only in the host credential area
			And supplies it only to that MCP sidecar process
			And never exposes it to Pi, tool declarations, logs, or connection listings
	When the user supplies one or more `--allow-url <url>` values
		Then integral gives the sidecar outbound access only within those normalized URL boundaries
			And does not inject another connection's credential into those requests
	When no `--allow-url` is supplied
		Then the sidecar has no external network access
	When the executable cannot start, emits invalid protocol data, exits during verification, or does not expose a valid tool catalog
		Then integral exits non-zero
			And removes the verification sidecar
			And does not store a partial connection or secret
*/
test("[CONNECTION-0EF2CF89] explicit stdio MCP setup preserves literal process configuration", async () => {
  assert.deepEqual(
    await explicitConnection([
      "mcp",
      "--name",
      "local",
      "--transport",
      "stdio",
      "--command",
      "node",
      "--arg",
      "server.js",
      "--arg",
      "$(not-a-shell)",
      "--env",
      "CACHE_DIR=/tmp/cache",
      "--secret-env",
      "API_TOKEN",
      "--allow-url",
      "https://api.example.test/v1",
    ]),
    {
      name: "local",
      kind: "mcp",
      auth: "none",
      transport: "stdio",
      command: "node",
      args: ["server.js", "$(not-a-shell)"],
      env: { CACHE_DIR: "/tmp/cache" },
      secretEnv: ["API_TOKEN"],
      allowedUrls: ["https://api.example.test/v1"],
    },
  );
});

/* @covers CONNECTION-89A88F7C
Given an existing bare Git repository is available at a host path
	When the user runs `integral connection add host-repo --name <name> --path <path> [--branch <branch>] --mount <container-path>`
		Then integral accepts an absolute host path or resolves a relative host path from the current directory
			And accepts an absolute container path or resolves a relative container path below `/home/pi`
			And canonicalizes the host path
			And validates that it is a bare Git repository readable and writable by the Integral host process
			And selects `--branch <branch>` when supplied
			And otherwise selects the repository's symbolic `HEAD` branch
			And uses `main` for an empty repository whose symbolic `HEAD` is unborn
			And stores a governed repository connection without a credential
			And does not copy, move, modify, or change ownership of the repository during setup
			And records the canonical path and filesystem identity of its backing root
			And validates and records the requested mount path in the same atomic operation
			And marks every live Pi session stale so the checkout appears before its next prompt
			And advances the connection generation
	When the path or mount is missing, invalid, already connected, or the repository has no selectable branch
		Then integral rejects setup without creating a connection or modifying the path
			And explains how to create a bare clone when the source is a working checkout
*/
/* @covers CONNECTION-857967F4
Given an existing host directory is available at a host path
	When the user runs `integral connection add host-store --name <name> --path <path> --mount <container-path>`
		Then integral accepts an absolute host path or resolves a relative host path from the current directory
			And accepts an absolute container path or resolves a relative container path below `/home/pi`
			And canonicalizes the host path
			And validates that it is a directory readable and writable by the Integral host process
			And stores a host-store connection without a credential
			And does not copy, move, modify, snapshot, or change ownership of the directory during setup
			And records the canonical path and filesystem identity of its backing root
			And validates and records the requested mount path in the same atomic operation
			And marks every live Pi session stale so the store is mounted before its next prompt
			And advances the connection generation
	When the path or mount is missing, invalid, already connected, or lacks required access
		Then integral rejects setup without creating a connection or modifying the path
*/
test("[CONNECTION-89A88F7C] [CONNECTION-857967F4] explicit host resources accept absolute and relative source and mount paths", async () => {
  assert.deepEqual(
    await explicitConnection([
      "host-repo",
      "--name",
      "code",
      "--path",
      "/srv/code.git",
      "--mount",
      "/home/pi/code",
      "--branch",
      "stable",
    ]),
    {
      name: "code",
      kind: "host-repo",
      auth: "none",
      path: "/srv/code.git",
      mount: "/home/pi/code",
      branch: "stable",
    },
  );
  assert.deepEqual(
    await explicitConnection([
      "host-store",
      "--name",
      "files",
      "--path",
      "var/../files",
      "--mount",
      "knowledge/../files",
    ]),
    {
      name: "files",
      kind: "host-store",
      auth: "none",
      path: resolve("files"),
      mount: "/home/pi/files",
    },
  );
});

/* @covers CONNECTION-06B6AE14
Given a host-repository or host-store connection exists
	When the user runs `integral connection ls`
		Then integral identifies it as `host-repo` or `host-store`
			And reports whether it is active, unavailable, or soft-deleted
			And reports a bounded availability reason and whether restoration is currently possible
			And reports its Pi mount path
			And does not print its canonical host path unless the user requests JSON output
	When the user runs `integral connection rm <name>` in an interactive terminal
		Then integral identifies the resource kind
			And displays the lifecycle revision to be removed
			And asks for confirmation
	When the user confirms removal
		And the displayed lifecycle revision remains current
		Then integral performs the same soft deletion as the matching Pi resource tool
			And does not terminate or replace an existing Pi session
			And reports that existing sessions retain their checkout or mount until they end naturally
			And never permanently deletes canonical repository or store content
	When the lifecycle revision changes while confirmation is pending
		Then integral rejects the stale confirmation without changing the connection
*/
test("[CONNECTION-06B6AE14] host-resource listing reports bounded health and restoration data without exposing host paths in text", async (t) => {
  const paths = await fixture(t),
    backing = `${paths.root}-listed-store`,
    env = { INTEGRAL_HOME: paths.root };
  t.after(() => rm(backing, { recursive: true, force: true }));
  await mkdir(backing);
  const resource = await addHostResource(
    paths,
    validateConnection({
      name: "listed",
      kind: "host-store",
      auth: "none",
      path: backing,
      mount: "/home/pi/listed",
    }),
    await loadConfig(paths, {}),
  );

  const human = await capture(["connection", "ls"], env);
  assert.match(
    human.stdout,
    /listed\thost-store\tnone\tactive\t-\trestorable=no\t\/home\/pi\/listed/,
  );
  assert.doesNotMatch(human.stdout, new RegExp(backing));

  await softDeleteResource(paths, "listed", resource.revision, "operator");
  const json = JSON.parse(
    (await capture(["connection", "ls", "--json"], env)).stdout,
  );
  assert.deepEqual(json, [
    {
      name: "listed",
      kind: "host-store",
      provider: null,
      auth: "none",
      state: "soft-deleted",
      resourceId: resource.id,
      lifecycleRevision: 2,
      mount: "/home/pi/listed",
      path: backing,
      availabilityReason: null,
      restorationPossible: true,
    },
  ]);
});

/* @covers CONNECTION-512D9A25
Given the selected connection type supports the requested authentication method
	When the user adds it with `--auth oauth`
		Then integral runs the configured OAuth authorization flow
	When the user adds it with `--auth device-code`
		Then integral runs the configured device authorization flow
			And displays the verification URL and user code
			And polls until authorization succeeds, fails, or expires
	When the user adds it with `--auth key`
		Then integral reads the key without echoing it
			And stores it in the host credential area
	When the user adds it with `--auth key --credential-stdin`
		Then integral reads one non-empty credential from standard input
			And does not require an interactive terminal
	When the user adds it with `--auth none`
		Then integral creates the connection without requesting or storing a credential
	When the user requests an authentication method unsupported by the entry
		Then integral rejects setup without creating a connection
	When an OAuth access token is within one minute of expiry
		Then the gateway refreshes it before using the connection
			And atomically stores the refreshed OAuth record
	When an expired OAuth credential cannot be refreshed
		Then the gateway excludes its credential from request injection
			And publishes degraded gateway health with the refresh error
*/
test("[CONNECTION-512D9A25] unsupported authentication is rejected before creating a declaration", async (t) => {
  const paths = await fixture(t),
    result = await capture(
      ["connection", "add", "anthropic", "--auth", "none"],
      { INTEGRAL_HOME: paths.root },
    );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not supported/);
});

/* @covers CONNECTION-2F7C9A61
Given the selected catalog entry supports more than one authentication method
	And the selected entry is not MCP
	When the user runs `integral connection add <entry>` without `--auth`
		Then integral lists the authentication methods supported by that entry
			And asks the user to choose one before starting authentication
			And does not assume an authentication method
	When standard input is not an interactive terminal
		Then integral requires `--auth`
			And identifies the supported values
	When the user supplies a supported method with `--auth <method>`
		Then integral uses that authentication method without asking
Given the selected catalog entry is MCP with a remote URL
	When the user adds it without `--auth`
		Then integral probes whether the server permits anonymous MCP access
			And follows standardized MCP authorization discovery when authentication is required
			And does not ask the user to choose an authentication family
Given the selected catalog entry supports exactly one authentication method
	When the user runs `integral connection add <entry>` without `--auth`
		Then integral selects that method without an echoed authentication prompt
			And begins its authentication flow directly
*/
test("[CONNECTION-2F7C9A61] interactive connection setup asks for a supported authentication method", async () => {
  let question = "",
    prompts = 0;
  const selected = await selectAuthentication(
    ["oauth", "key"],
    undefined,
    async (message) => {
      prompts++;
      question = message;
      return "key";
    },
  );
  assert.equal(selected, "key");
  assert.match(question, /oauth\/key/);
  assert.equal(
    await selectAuthentication(["oauth", "key"], "oauth", async () => {
      prompts++;
      return "key";
    }),
    "oauth",
  );
  assert.equal(prompts, 1, "--auth must bypass the prompt");
});

test("[CONNECTION-2F7C9A61] a singleton authentication method is selected without an echoed prompt", async () => {
  let prompts = 0;
  assert.equal(
    await selectAuthentication(["key"], undefined, async () => {
      prompts++;
      return "secret-that-must-not-be-echoed";
    }),
    "key",
  );
  assert.equal(await selectAuthentication(["key"]), "key");
  assert.equal(prompts, 0);
});

/* @covers EMAIL-B765A312
Given the connection catalog contains Gmail and Mailgun email providers
	When the user configures a Gmail email connection
		Then the connection may enable `read`, `search`, and `send`
			And uses OAuth with the scopes required by its enabled capabilities
			And requires the authenticated account address and OAuth client ID
	When the user configures a Mailgun email connection
		Then the connection enables only `send`
			And requires a sending domain, fixed From address, region, and API key
			And interactive setup selects `send` without a capability prompt
	When the user interactively adds Gmail or Mailgun without required email options
		Then integral prompts for the missing non-secret account and policy options
			And requests the credential only after those options are valid
	When an email connection enables `send`
		Then it requires at least one exact-address or domain-wildcard allowed recipient policy
			And an omitted policy or catch-all wildcard never means allow all recipients
	When an email connection requests a capability unsupported by its provider
		Then integral rejects the declaration without storing credentials
*/
test("[EMAIL-B765A312] interactive Mailgun setup collects policy before hidden key authentication", async () => {
  const answers = ["mg.example.com", "robot@mg.example.com", "*@example.com"],
    prompts: string[] = [],
    raw: Record<string, unknown> = {
      name: "mailgun",
      kind: "email",
      provider: "mailgun",
      auth: "key",
    };
  await completeEmailOptions("mailgun", raw, async (message) => {
    prompts.push(message);
    return answers.shift()!;
  });
  assert.deepEqual(raw, {
    name: "mailgun",
    kind: "email",
    provider: "mailgun",
    auth: "key",
    capabilities: ["send"],
    domain: "mg.example.com",
    from_address: "robot@mg.example.com",
    allowed_recipients: ["*@example.com"],
  });
  assert.doesNotMatch(
    prompts.join("\n"),
    /Authentication|Capabilities|API key|Credential/,
  );
});

test("[CONNECTION-2F7C9A61] non-interactive connection setup requires --auth and names supported choices", async (t) => {
  const paths = await fixture(t),
    result = await capture(["connection", "add", "anthropic"], {
      INTEGRAL_HOME: paths.root,
    });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /use --auth.*oauth, key/);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /Credential \(hidden/,
  );
});

/* @covers CONNECTION-03C4E791
Given an interactive terminal
	When the user runs `integral connection add`
		Then integral presents the connection catalog
			And lets the user select a provider or generic connection type
			And lets the user name the connection
			And lets the user select an authentication method when required
			And collects the endpoint and protocol details required by the type
			And normally asks only for a name and URL when the selected type is remote MCP
			And collects a command and arguments when the selected type is stdio MCP
			And treats MCP authentication and transport choices as advanced compatibility overrides
			And requires a mount path for a host resource
			And runs the selected authentication flow
			And completes the same setup as explicit `connection add <entry>`
*/
test("[CONNECTION-03C4E791] bare add clearly requires the guided interactive terminal", async (t) => {
  const paths = await fixture(t),
    result = await capture(["connection", "add"], {
      INTEGRAL_HOME: paths.root,
    });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /guided connection setup requires an interactive terminal/,
  );
});

/* @covers CONNECTION-1D691391
Given the selected catalog entry supports credential verification
	When the user runs `integral connection add <entry> --verify`
		And authentication succeeds
		Then integral makes one authenticated `HEAD` request through trusted host code
			And completes setup only when verification succeeds
			And reports verification failure without printing secret values
*/
test("[CONNECTION-1D691391] verification occurs before setup is committed", async (t) => {
  const paths = await fixture(t),
    result = await capture(
      [
        "connection",
        "add",
        "http",
        "--name",
        "bad",
        "--url",
        "http://127.0.0.1:1",
        "--auth",
        "none",
        "--verify",
      ],
      { INTEGRAL_HOME: paths.root },
    );
  assert.equal(result.code, 1);
  const ls = await capture(["connection", "ls", "--json"], {
    INTEGRAL_HOME: paths.root,
  });
  assert.deepEqual(JSON.parse(ls.stdout), []);
});

/* @covers CONFIG-5F20A9D3
Given integral is installed
	When the user runs `integral config --help`
		Then the command lists `init`, `path`, `show`, and `validate`
			And describes `show` as effective configuration after overrides
*/
test("[CONFIG-5F20A9D3] config help lists init, path, effective show, and validate", async () => {
  const result = await capture(["config", "--help"]);
  for (const name of [
    "init",
    "path",
    "show",
    "validate",
    "effective configuration",
  ])
    assert.match(result.stdout, new RegExp(name));
});

/* @covers CONFIG-17D6C8A4
Given integral has resolved an `INTEGRAL_HOME`
	When the user runs `integral config path`
		Then integral prints the absolute path to `<INTEGRAL_HOME>/config/integral.toml`
			And does not require that file to exist
*/
/* @covers CONFIG-C41E8B75
Given the main configuration file does not exist
	When the user runs `integral config init`
		Then integral creates `<INTEGRAL_HOME>/config/integral.toml`
			And creates missing parent directories
			And writes valid TOML containing documented defaults and comments
			And does not write credentials or machine-specific session state
	When the file already exists
		Then `integral config init` refuses to overwrite it
			And leaves its bytes unchanged
*/
test("[CONFIG-17D6C8A4] [CONFIG-C41E8B75] config path and init use only the resolved deployment", async (t) => {
  const paths = await fixture(t),
    env = { INTEGRAL_HOME: paths.root };
  assert.equal(
    (await capture(["config", "path"], env)).stdout.trim(),
    paths.mainConfig,
  );
  assert.equal((await capture(["config", "init"], env)).code, 0);
  assert.equal((await capture(["config", "init"], env)).code, 1);
});

/* @covers CONFIG-B93A4E70
Given configuration files may be valid or invalid
	When the user runs `integral config validate`
		Then integral parses and validates the same effective configuration used by components
			And reports all independently discoverable validation errors together
			And exits non-zero when any error exists
			And does not start components, create containers, or change configuration
	When the user runs `integral config validate --json`
		Then integral reports the same validation result as structured JSON
*/
/* @covers CONFIG-D4A70C31
Given built-in defaults, main configuration, and environment overrides may apply
	When the user runs `integral config show`
		Then integral prints the effective configuration
			And identifies each value as built-in, file, or environment sourced
			And includes component ports and connection names
			And formats human output as readable sections with one option per line
			And does not render sections as inline JSON objects
			And redacts credentials and internal component identities
	When the user runs `integral config show --json`
		Then integral returns the same effective values and sources as structured JSON
*/
test("[CONFIG-B93A4E70] [CONFIG-D4A70C31] validate and show offer equivalent machine-readable configuration", async (t) => {
  const paths = await fixture(t),
    env = { INTEGRAL_HOME: paths.root };
  const valid = await capture(["config", "validate", "--json"], env);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  const shown = await capture(["config", "show", "--json"], env);
  const value = JSON.parse(shown.stdout);
  assert.equal(value.server.gatewayPort, 7310);
  assert.equal(value.sources["server.gateway_port"], "built-in");
});

test("[CONFIG-D4A70C31] human config output uses readable sourced sections instead of inline JSON", async (t) => {
  const paths = await fixture(t),
    shown = await capture(["config", "show"], {
      INTEGRAL_HOME: paths.root,
      INTEGRAL_GATEWAY_PORT: "7400",
    });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^Effective configuration$/m);
  assert.match(shown.stdout, /^\[server\]$/m);
  assert.match(shown.stdout, /^gateway_port = 7400 {2}# source: environment$/m);
  assert.match(shown.stdout, /^\[runner\]$/m);
  assert.match(shown.stdout, /^\[connections\]\nnames = \[\]$/m);
  assert.doesNotMatch(shown.stdout, /^server: \{/m);
});

/* @covers SERVER-2C8F41A7
Given integral is installed
	When the user runs `integral server start --help`
		Then the command describes combined mode as the default
			And lists `coordinator`, `runner`, `gateway`, and `scheduler` as component values
			And describes `--component <name>` as single-component mode
*/
test("[SERVER-2C8F41A7] component startup help documents combined and four separate modes", async () => {
  const result = await capture(["server", "start", "--help"]);
  for (const word of [
    "Combined mode",
    "--component",
    "coordinator",
    "runner",
    "gateway",
    "scheduler",
  ])
    assert.match(result.stdout, new RegExp(word));
});

/* @covers QUEUE-A19D6F43
Given the durable queue contains zero or more messages
	When an attached user enters `/queue ls`
		Then integral lists queued messages in delivery order
			And shows each message's stable ID and text
			And identifies the in-flight message separately
			And shows the same result in every attached terminal
			And does not send the command to Pi
	When the user runs `integral queue ls`
		Then integral requests the same queue snapshot from the coordinator without attaching a talk session
			And lists each message's state, stable ID, and text in delivery order
	When the user runs `integral queue ls --json`
		Then integral prints the same ordered queue snapshot as JSON
*/
/* @covers QUEUE-C84E1A70
Given a message is durably queued and not in flight
	When an attached user enters `/queue edit <id> <text>`
		Then integral atomically replaces that message's text
			And preserves its stable ID and queue position
			And persists the edit before reporting success
			And updates the corresponding durable user-conversation event
			And broadcasts the edited message to every attached terminal
			And sends only the edited text when the message is later claimed
	When the user runs `integral queue edit <id> <text>`
		Then integral requests the same atomic edit from the coordinator without attaching a talk session
			And confirms the edited message ID after the coordinator accepts it
	When the replacement text is empty or whitespace-only
		Then integral rejects the edit without changing the queue or conversation
*/
/* @covers QUEUE-2F6B9D04
Given a message is durably queued and not in flight
	When an attached user enters `/queue delete <id>`
		Then integral atomically removes the message from the delivery queue
			And persists the deletion before reporting success
			And removes the corresponding durable user-conversation event
			And broadcasts the deletion to every attached terminal
			And never sends the deleted message to Pi
	When the user runs `integral queue delete <id>`
		Then integral requests the same atomic deletion from the coordinator without attaching a talk session
			And confirms the deleted message ID after the coordinator accepts it
*/
test("[QUEUE-A19D6F43] [QUEUE-C84E1A70] [QUEUE-2F6B9D04] top-level queue commands use the coordinator without attaching a talk session", async (t) => {
  const paths = await fixture(t),
    requests: { path: string; method: string; body?: string }[] = [];
  let stdout = "";
  const dependencies = {
    resolvePaths: () => paths,
    componentEndpoint: async () => "http://coordinator.test",
    verifiedFetch: async () => new Response("ok"),
    writeOutput(text: string) {
      stdout += text;
    },
    async fetch(input: string | URL | Request, init?: RequestInit) {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (url.pathname === "/integral/snapshot")
        return Response.json({
          queue: [
            { id: "message-1", text: "first", status: "in-flight" },
            { id: "message-2", text: "second", status: "queued" },
          ],
        });
      return new Response(null, { status: 204 });
    },
  };

  assert.equal(await queueCommand(["ls"], dependencies), 0);
  assert.match(stdout, /in-flight\tmessage-1\tfirst/);
  assert.match(stdout, /queued\tmessage-2\tsecond/);
  stdout = "";
  assert.equal(await queueCommand(["ls", "--json"], dependencies), 0);
  assert.deepEqual(JSON.parse(stdout), [
    { id: "message-1", text: "first", status: "in-flight" },
    { id: "message-2", text: "second", status: "queued" },
  ]);
  stdout = "";
  assert.equal(
    await queueCommand(
      ["edit", "message-2", "revised", "message"],
      dependencies,
    ),
    0,
  );
  assert.equal(stdout, "Edited message-2.\n");
  stdout = "";
  assert.equal(await queueCommand(["delete", "message-2"], dependencies), 0);
  assert.equal(stdout, "Deleted message-2.\n");
  assert.deepEqual(
    requests.map((request) => [request.method, request.path, request.body]),
    [
      ["GET", "/integral/snapshot", undefined],
      ["GET", "/integral/snapshot", undefined],
      [
        "PATCH",
        "/integral/queue/message-2",
        JSON.stringify({ text: "revised message" }),
      ],
      ["DELETE", "/integral/queue/message-2", undefined],
    ],
  );
  assert.equal(
    requests.some((request) => request.path === "/integral/events"),
    false,
  );
});

/* @covers QUEUE-947D3AC0
Given a queue edit, delete, completion, or release operation names an unknown or deleted message ID
	When the coordinator evaluates the command
		Then integral rejects the operation without changing the queue
			And reports that the message is not queued
*/
test("[QUEUE-947D3AC0] top-level queue commands report coordinator rejections", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    queueCommand(["delete", "missing"], {
      resolvePaths: () => paths,
      componentEndpoint: async () => "http://coordinator.test",
      verifiedFetch: async () => new Response("ok"),
      writeOutput() {},
      fetch: async () =>
        Response.json(
          { error: "message missing is not queued" },
          { status: 404 },
        ),
    }),
    /message missing is not queued/,
  );
});

/* @covers CHAT-84D839CE
Given the user is in `integral talk`
	When the user enters `/help`
		Then the terminal describes `/help`, `/status`, `/model [<pattern>...]`, `/queue ls`, `/queue edit`, `/queue delete`, and `/exit`
			And handles the command on the host
			And does not send the command to Pi
*/
test("[CHAT-84D839CE] [GATEWAY-846B1000] talk help documents every local command and never contacts Pi", async () => {
  const result = await capture(["talk", "--help"]);
  for (const command of [
    "/help",
    "/status",
    "/model",
    "/queue ls",
    "/queue edit",
    "/queue delete",
    "/approvals",
    "/approve",
    "/deny",
    "/exit",
  ])
    assert.match(result.stdout, new RegExp(command.replace("/", "\\/")));
});

/* @covers CHAT-DB0EF523
Given no healthy coordinator is reachable
	When the user runs `integral talk`
		Then the command exits non-zero
			And tells the user to start the coordinator or run `integral server start`
			And does not start an ungoverned local Pi process
*/
test("[CHAT-DB0EF523] talk refuses to start an ungoverned Pi when no coordinator is discoverable", async (t) => {
  const paths = await fixture(t),
    result = await capture(["talk"], { INTEGRAL_HOME: paths.root });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /coordinator is not reachable.*integral server start/,
  );
});

/* @covers CHAT-888AFAE0
Given the terminal is interactive
	And the integral coordinator is healthy
	When the user runs `integral talk`
		Then the terminal shows a stable person-symbol input prompt
			And displays asynchronous conversation events above the input prompt instead of after its prefix
			And redraws any input already being typed after an asynchronous event
			And trims input before interpreting or submitting it
			And submits each non-empty input line to the coordinator-owned queue
			And ignores empty or whitespace-only input
			And does not repeat a user message already echoed by that terminal's input editor
			And displays user messages submitted by other attached terminals
			And labels every human message with a person symbol
			And gives each full person-labeled message a distinct background color on color terminals
			And does not emit color escapes to non-color output
			And labels every assistant or error message with `∮`
			And displays assistant text emitted by Pi as assistant output
			And does not display protocol events or raw JSON
			And does not display model credentials
	When the user enters an unrecognized line beginning with `/`
		Then integral reports an unknown local command on stderr
			And does not submit the line to the coordinator or Pi
Given the user is in `integral talk`
	When a Pi process is active inside its container
		And that Pi process is working on an in-flight message
		Then the terminal animates a `∮` working indicator on its own line
			And keeps the human input prompt on the following line
			And does not disturb input already being typed
	When no Pi container is active or the active Pi process is idle
		Then the terminal does not animate the working indicator
*/
test("[CHAT-888AFAE0] asynchronous events redraw the active prompt and preserve pending input", async () => {
  const actions: string[] = [];
  let finishQuestion!: (answer: string) => void, tick!: () => void;
  const questionResult = new Promise<string>((resolve) => {
      finishQuestion = resolve;
    }),
    terminal = createTalkTerminal({
      terminal: {
        line: "draft",
        cursor: 2,
        question: async () => questionResult,
        close() {
          actions.push("close");
        },
      },
      output: {
        isTTY: true,
        write(text) {
          actions.push(`write:${text}`);
        },
      },
      controls: {
        clearLine() {
          actions.push("clear");
        },
        cursorTo() {
          actions.push("start");
        },
        moveCursor(_output, horizontal, vertical = 0) {
          actions.push(`move:${horizontal}:${vertical}`);
        },
      },
      clock: {
        setInterval(callback, milliseconds) {
          tick = callback;
          actions.push(`interval:${milliseconds}`);
          return "animation";
        },
        clearInterval(handle) {
          actions.push(`clearInterval:${String(handle)}`);
        },
      },
    }),
    pending = terminal.question("☺ ");

  terminal.writeEvent!("∮ hello\n");
  assert.deepEqual(actions, [
    "clear",
    "start",
    "write:∮ hello\n",
    "write:☺ draft",
    "move:-3:0",
  ]);

  actions.length = 0;
  terminal.setWorking!(true);
  assert.deepEqual(actions, [
    "clear",
    "start",
    "write:∮   \n☺ draft",
    "move:-3:0",
    "interval:160",
  ]);
  actions.length = 0;
  tick();
  assert.deepEqual(actions, [
    "clear",
    "start",
    "move:0:-1",
    "clear",
    "start",
    "write:∮·  \n☺ draft",
    "move:-3:0",
  ]);
  actions.length = 0;
  terminal.writeEvent!("∮ partial update\n");
  assert.deepEqual(actions, [
    "clear",
    "start",
    "move:0:-1",
    "clear",
    "start",
    "write:∮ partial update\n",
    "write:∮·  \n☺ draft",
    "move:-3:0",
  ]);
  actions.length = 0;
  terminal.setWorking!(false);
  assert.deepEqual(actions, [
    "clearInterval:animation",
    "clear",
    "start",
    "move:0:-1",
    "clear",
    "start",
    "write:☺ draft",
    "move:-3:0",
  ]);

  finishQuestion("done");
  assert.equal(await pending, "done");
  terminal.writeEvent!("∮ later\n");
  assert.equal(actions.at(-1), "write:∮ later\n");
});

/* @covers BOX-E1F472A1
Given integral begins Pi-specific OAuth or opens the model chooser
	When the npm registry reports a newer `latest` Pi version
		Then integral installs that exact version under deployment runtime state
			And uses that exact version when the model chooser builds the default Pi image
			And the chooser discovers providers and models from that image
			And records the version and immutable image identity when the user selects a model
	When the npm registry reports the same version as the installed runtime
		Then integral reuses the installed host runtime
			And the model chooser reuses the matching image when it is available
			And distinguishes managed images built from different Integral image recipes
			And does not reinstall Pi
	When the npm registry cannot be reached
		And the previously installed Pi runtime and any image required by the operation are valid
		Then integral reuses the installed runtime
			And warns that it could not check for a newer Pi version
	When the npm registry cannot be reached
		And no valid installed Pi runtime exists
		Then the Pi-dependent operation exits non-zero
			And explains that no cached Pi runtime is available
Given a conversation selection records a Pi version and immutable image identity
	When the runner provisions or reuses a Pi container
		Then it uses that immutable image identity
			And treats a runtime identity change as a model-selection change
			And never substitutes another locally tagged Pi image
*/
/* @covers CHAT-6E91B4C7
Given the terminal is interactive
	And the integral coordinator is healthy
	When the user runs `integral talk`
		And at least one active model connection exists
		And the conversation has no selected model connection and model
		Then integral opens the model chooser
			And records both selections as durable conversation state
			And does not write either selection to the main configuration
			And attaches the terminal only after both selections are valid
	When the user runs `integral talk`
		And the conversation has a previously selected model connection and model
		And both selections remain available
		Then integral reuses the previous selections without opening the model chooser
			And refreshes the selected Pi runtime identity when the available runtime changed
			And attaches the terminal to the same conversation
	When the user runs `integral talk <pattern>...`
		And at least one active model connection exists
		Then integral opens the model chooser and applies each pattern argument as a search term
			And attaches the terminal only after the terms resolve to a valid selection
			And does not write the selection to the main configuration
	When the user runs `integral talk`
		And at least one active model connection exists
		And the conversation has a previously selected model connection and model
		And either selection is no longer available
		Then integral explains why the previous selections cannot be reused
			And opens the model chooser without a default
			And replaces both selections in durable conversation state
			And does not write either selection to the main configuration
	When the user runs `integral talk`
		And no active model connection exists
		Then the command exits non-zero
			And instructs the user to run `integral connection add`
			And does not attach the terminal or change the conversation's selections
*/
/* @covers CHAT-989F5C14
Given the user is in `integral talk`
	When the user enters `/status`
		Then the terminal reports whether the gateway is healthy
			And reports whether the runner is healthy
			And reports whether the Pi container is healthy
			And identifies the conversation's selected connection, provider, and model
			Or reports that the conversation requires a selection
			And identifies the current session when one is active
			And reports the queue depth and number of attached terminals
			And identifies the in-flight message when one exists
			And does not print secrets
*/
test("[BOX-E1F472A1] [CHAT-6E91B4C7] [CHAT-888AFAE0] [CHAT-84D839CE] [CHAT-989F5C14] [GATEWAY-846B1000] scripted terminal silently reuses the current model on a refreshed runtime before handling local commands", async (t) => {
  const paths = await fixture(t),
    userLabel = "\u001b[48;5;238m\u001b[97m ☺ ",
    lines = [
      "   ",
      "   ",
      "/help",
      "/status",
      "/queue ls",
      "/queue edit message-1 revised text",
      "/queue delete message-1",
      "/approvals",
      "/approve approval-1",
      "/deny approval-2",
      "/unknown",
      "  hello Pi  ",
      "/exit",
    ],
    prompts: string[] = [],
    requests: { path: string; method: string; body?: string }[] = [];
  let stdout = "",
    stderr = "";
  const workingStates: boolean[] = [];
  const events = new TextEncoder().encode(
    'event: snapshot\ndata: {"conversation":[{"type":"user","text":"persisted"},{"type":"session","text":"hidden"}]}\n\n' +
      'event: conversation.user\ndata: {"type":"user","text":"local echo","terminalId":"terminal-test"}\n\n' +
      'event: conversation.user\ndata: {"type":"user","text":"from another terminal","terminalId":"terminal-other"}\n\n' +
      'event: queue.claimed\ndata: {"type":"claimed","message":{"status":"in-flight"}}\n\n' +
      'event: conversation.session\ndata: {"type":"session","text":"started","sessionId":"session-1"}\n\n' +
      'event: conversation.assistant\ndata: {"type":"assistant","text":"response"}\n\n',
  );

  const code = await talkCommand([], {
    resolvePaths: () => paths,
    componentEndpoint: async () => "http://coordinator.test",
    verifiedFetch: async () => new Response("ok"),
    createTerminalId: () => "terminal-test",
    createTerminal: () => ({
      colors: true,
      async question(prompt) {
        prompts.push(prompt);
        const line = lines.shift();
        if (line === undefined) throw new Error("EOF");
        return line;
      },
      writeEvent(text) {
        stdout += `[event]${text}`;
      },
      setWorking(working) {
        workingStates.push(working);
      },
      close() {},
    }),
    writeOutput(text) {
      stdout += text;
    },
    writeError(text) {
      stderr += text;
    },
    async fetch(input, init) {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (url.pathname === "/integral/events")
        return new Response(events, {
          headers: { "x-integral-attachment-id": "attachment-test" },
        });
      if (url.pathname === "/integral/models")
        return Response.json({
          choices: [
            {
              connection: "work",
              provider: "openai-codex",
              model: "gpt-5.5",
              piVersion: "1.2.3",
              piImage: "sha256:current",
            },
          ],
          current: {
            connection: "work",
            provider: "openai-codex",
            model: "gpt-5.5",
            piVersion: "1.2.2",
            piImage: "sha256:old",
          },
        });
      if (url.pathname === "/integral/status")
        return Response.json({
          gateway: "healthy",
          runner: "healthy",
          container: "idle",
          session: null,
          selection: {
            connection: "work",
            provider: "openai-codex",
            model: "gpt-5.5",
          },
          queueDepth: 1,
          inFlight: null,
          attached: 1,
        });
      if (url.pathname === "/integral/snapshot")
        return Response.json({
          queue: [{ id: "message-1", text: "queued", status: "queued" }],
        });
      if (url.pathname === "/integral/approvals")
        return Response.json([
          {
            id: "approval-1",
            status: "pending",
            summary: "install Debian packages: jq",
          },
        ]);
      if (url.pathname.startsWith("/integral/approvals/"))
        return Response.json({
          id: url.pathname.split("/")[3],
          status: url.pathname.endsWith("/approve") ? "succeeded" : "denied",
          summary: "install Debian packages: jq",
        });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(code, 0);
  assert.ok(prompts.every((prompt) => prompt === userLabel));
  assert.doesNotMatch(stdout, /Available models/);
  assert.ok(stdout.includes(`[event]${userLabel}persisted \u001b[0m`));
  assert.doesNotMatch(stdout, /local echo/);
  assert.ok(
    stdout.includes(`[event]${userLabel}from another terminal \u001b[0m`),
  );
  assert.match(stdout, /\[event\]∮ response/);
  assert.deepEqual(workingStates, [true, false, false, false]);
  assert.doesNotMatch(stdout, /hidden/);
  assert.match(stdout, /gateway.*healthy/s);
  assert.match(stdout, /queued\tmessage-1\tqueued/);
  assert.match(stdout, /approval approval-1 \[pending\]/);
  assert.match(stdout, /approval approval-1 \[succeeded\]/);
  assert.match(stdout, /approval approval-2 \[denied\]/);
  assert.match(stderr, /Unknown local command/);
  assert.deepEqual(
    requests
      .filter((request) => request.method !== "GET")
      .map((request) => [request.method, request.path, request.body]),
    [
      [
        "PUT",
        "/integral/selection",
        JSON.stringify({ connection: "work", model: "gpt-5.5" }),
      ],
      [
        "PATCH",
        "/integral/queue/message-1",
        JSON.stringify({ text: "revised text" }),
      ],
      ["DELETE", "/integral/queue/message-1", undefined],
      [
        "POST",
        "/integral/approvals/approval-1/approve",
        JSON.stringify({ attachmentId: "attachment-test" }),
      ],
      [
        "POST",
        "/integral/approvals/approval-2/deny",
        JSON.stringify({ attachmentId: "attachment-test" }),
      ],
      [
        "POST",
        "/integral/messages",
        JSON.stringify({ text: "hello Pi", terminalId: "terminal-test" }),
      ],
    ],
  );
});

/* @covers CHAT-4F29A6D8
Given conversation events were acknowledged before the coordinator stopped or crashed
	When the coordinator starts again with the same `$INTEGRAL_HOME`
		Then integral restores the events in their committed order
			And restores any selected model connection and model
	When a terminal attaches after that restart
		Then it receives the restored conversation and current queue
			And follows subsequent events in the same logical conversation
	When an attached terminal loses the coordinator because the server restarts
		Then the terminal remains open and reports that it is reconnecting
			And reconnects to the coordinator for the same `$INTEGRAL_HOME`
			And reconciles from the restored snapshot without rendering acknowledged conversation events twice
			And accepts new local commands and messages after reconnection
*/
test("[CHAT-4F29A6D8] an attached talk terminal reconnects after coordinator restart without replaying conversation", async (t) => {
  const paths = await fixture(t),
    encoder = new TextEncoder(),
    firstEvents = encoder.encode(
      'event: snapshot\ndata: {"conversation":[{"type":"user","text":"persisted","sequence":1}],"queue":[]}\n\n',
    );
  let endpointCalls = 0,
    eventCalls = 0,
    stdout = "",
    stderr = "",
    postedHost = "";
  let reconnected: (() => void) | undefined;
  const reconnectedPromise = new Promise<void>((resolve) => {
    reconnected = resolve;
  });
  let questions = 0;

  const code = await talkCommand([], {
    resolvePaths: () => paths,
    componentEndpoint: async () =>
      endpointCalls++ === 0
        ? "http://coordinator-before.test"
        : "http://coordinator-after.test",
    verifiedFetch: async () => new Response("ok"),
    createTerminalId: () => "terminal-reconnect",
    createTerminal: () => ({
      async question() {
        if (questions++ === 0) {
          await reconnectedPromise;
          return "after restart";
        }
        return "/exit";
      },
      close() {},
    }),
    writeOutput(text) {
      stdout += text;
      if (text.includes("coordinator reconnected")) reconnected?.();
    },
    writeError(text) {
      stderr += text;
    },
    async fetch(input, init) {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      if (url.pathname === "/integral/models")
        return Response.json({
          choices: [
            {
              connection: "work",
              provider: "openai-codex",
              model: "gpt-5.5",
              piVersion: "1.2.3",
              piImage: "sha256:current",
            },
          ],
          current: {
            connection: "work",
            provider: "openai-codex",
            model: "gpt-5.5",
            piVersion: "1.2.3",
            piImage: "sha256:current",
          },
        });
      if (url.pathname === "/integral/events") {
        if (eventCalls++ === 0)
          return new Response(firstEvents, {
            headers: { "x-integral-attachment-id": "attachment-first" },
          });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: snapshot\ndata: {"conversation":[{"type":"user","text":"persisted","sequence":1},{"type":"assistant","text":"restored","sequence":2}],"queue":[]}\n\n',
              ),
            );
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        });
        return new Response(stream, {
          headers: { "x-integral-attachment-id": "attachment-restored" },
        });
      }
      if (url.pathname === "/integral/messages") {
        postedHost = url.hostname;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(code, 0);
  assert.equal(stdout.match(/persisted/g)?.length, 1);
  assert.equal(stdout.match(/restored/g)?.length, 1);
  assert.match(stdout, /coordinator reconnected/);
  assert.match(stderr, /coordinator disconnected; reconnecting/);
  assert.equal(postedHost, "coordinator-after.test");
});

/* @covers CHAT-C53A90D2
Given integral opens the model chooser for `integral talk` or `/model`
	When the coordinator has already discovered models for the current connection generation and configuration
		Then it serves the cached catalog without repeating Pi version, image, or model discovery
			And invalidates that catalog after the connection generation changes
	When it displays the available choices
		And at least one active model connection exists
		Then it groups models under each active model connection
			And identifies each connection name and provider
			And identifies every available model by name
			And identifies the Pi runtime version that supplied the choices
			And marks the conversation's current choice when it remains available
			And explains that the user may enter a choice number or one or more search terms
			And shows `integral talk [<pattern>...]` and `/model [<pattern>...]` as equivalent ways to search
	When no active model connection exists
		Then integral reports that no provider and model choices are available
			And instructs the user to run `integral connection add`
			And does not change the conversation's selection
	When the user enters a choice number
		Then integral selects the corresponding displayed connection, provider, and model
	When the user enters one or more search terms
		Then integral treats each term as a case-insensitive substring
			And compares it with connection names, provider names, and model names
			And keeps choices for which every term matches at least one of those fields
	When the terms identify exactly one choice
		Then integral selects that connection, provider, and model
	When the terms identify multiple choices
		Then integral displays only the matching choices
			And asks the user to narrow the selection or enter a displayed choice number
			And does not change the conversation's selection
	When no choice matches the terms
		Then integral reports that no provider and model match
			And displays all available choices again
			And does not change the conversation's selection
Given the user is in `integral talk`
	When the user enters `/model`
		Then integral opens the same model chooser used by `integral talk`
			And handles the command on the host
			And does not send the command to Pi
	When the user enters `/model <pattern>...`
		Then integral applies each pattern argument as a search term in that chooser
			And handles the command on the host
			And does not send the command to Pi
Given the model chooser resolves a valid choice
	When no Pi turn is in flight
		And the conversation has no current choice or the resolved choice is different
		Then integral records the new connection, model, and Pi runtime identity as durable conversation state
			And terminates any active Pi container
			And uses that exact Pi runtime when the next message provisions Pi
	When a Pi turn is in flight
		And the resolved choice is different from the conversation's current choice
		Then integral refuses to change the selection until the turn finishes
			And leaves the current connection, model, and Pi session unchanged
*/
test("[CHAT-6E91B4C7] [CHAT-C53A90D2] integral talk patterns and /model use one provider-and-model chooser", async (t) => {
  const paths = await fixture(t),
    choices = [
      {
        connection: "personal",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        piVersion: "1.2.3",
        piImage: "sha256:catalog",
      },
      {
        connection: "work",
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        piVersion: "1.2.3",
        piImage: "sha256:catalog",
      },
      {
        connection: "work",
        provider: "openai-codex",
        model: "gpt-5.5",
        piVersion: "1.2.3",
        piImage: "sha256:catalog",
      },
    ];
  let current: (typeof choices)[number] | null = null,
    stdout = "";
  const lines = ["/model anth sonnet", "/exit"],
    updates: unknown[] = [];
  const code = await talkCommand(["codex", "5.5"], {
    resolvePaths: () => paths,
    componentEndpoint: async () => "http://coordinator.test",
    verifiedFetch: async () => new Response("ok"),
    createTerminal: () => ({
      async question() {
        const line = lines.shift();
        if (line === undefined) throw new Error("EOF");
        return line;
      },
      close() {},
    }),
    writeOutput(text) {
      stdout += text;
    },
    writeError() {},
    async fetch(input, init) {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      if (url.pathname === "/integral/models")
        return Response.json({ choices, current });
      if (url.pathname === "/integral/selection") {
        const raw = init?.body;
        if (typeof raw !== "string") throw new Error("missing request body");
        const body = JSON.parse(raw) as {
          connection: string;
          model: string;
        };
        current =
          choices.find(
            (choice) =>
              choice.connection === body.connection &&
              choice.model === body.model,
          ) ?? null;
        updates.push(body);
        return Response.json(current);
      }
      if (url.pathname === "/integral/events")
        return new Response("", {
          headers: { "x-integral-attachment-id": "attachment-model" },
        });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(updates, [
    { connection: "work", model: "gpt-5.5" },
    { connection: "personal", model: "claude-sonnet-4-6" },
  ]);
  assert.match(stdout, /work \(openai-codex\)/);
  assert.match(stdout, /personal \(anthropic\)/);
  assert.match(stdout, /Selected work \(openai-codex\) \/ gpt-5\.5/);
  assert.match(stdout, /Selected personal \(anthropic\) \/ claude-sonnet-4-6/);
});

test("[CHAT-6E91B4C7] [CHAT-C53A90D2] chooser handles stale defaults, ambiguity, numbers, and unmatched slash patterns", async (t) => {
  const paths = await fixture(t),
    choices = [
      {
        connection: "personal",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        piVersion: "1.2.3",
        piImage: "sha256:catalog",
      },
      {
        connection: "work",
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        piVersion: "1.2.3",
        piImage: "sha256:catalog",
      },
      {
        connection: "work",
        provider: "openai-codex",
        model: "gpt-5.5",
        piVersion: "1.2.3",
        piImage: "sha256:catalog",
      },
    ];
  let current = {
      connection: "removed",
      provider: "anthropic",
      model: "removed-model",
      piVersion: "1.2.2",
      piImage: "sha256:removed",
    },
    stdout = "";
  const lines = ["2", "/model missing", "1", "/exit"],
    updates: { connection: string; model: string }[] = [];
  await talkCommand(["gpt"], {
    resolvePaths: () => paths,
    componentEndpoint: async () => "http://coordinator.test",
    verifiedFetch: async () => new Response("ok"),
    createTerminal: () => ({
      async question() {
        const line = lines.shift();
        if (line === undefined) throw new Error("EOF");
        return line;
      },
      close() {},
    }),
    writeOutput(text) {
      stdout += text;
    },
    writeError() {},
    async fetch(input, init) {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      if (url.pathname === "/integral/models")
        return Response.json({ choices, current });
      if (url.pathname === "/integral/selection") {
        const raw = init?.body;
        if (typeof raw !== "string") throw new Error("missing request body");
        const body = JSON.parse(raw) as {
          connection: string;
          model: string;
        };
        const selected = choices.find(
          (choice) =>
            choice.connection === body.connection &&
            choice.model === body.model,
        );
        assert.ok(selected);
        current = selected;
        updates.push(body);
        return Response.json(selected);
      }
      if (url.pathname === "/integral/events")
        return new Response("", {
          headers: { "x-integral-attachment-id": "attachment-removed" },
        });
      return new Response(null, { status: 204 });
    },
  });

  assert.deepEqual(updates, [
    { connection: "work", model: "gpt-5.5" },
    { connection: "personal", model: "claude-sonnet-4-6" },
  ]);
  assert.match(stdout, /Previous model removed/);
  assert.match(stdout, /Multiple models match/);
  assert.match(stdout, /No provider and model match/);
  assert.match(
    stdout,
    /integral talk <pattern>\.\.\. or \/model <pattern>\.\.\./,
  );
});

test("[CHAT-6E91B4C7] integral talk refuses attachment when no active provider and model choices remain", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    talkCommand([], {
      resolvePaths: () => paths,
      componentEndpoint: async () => "http://coordinator.test",
      verifiedFetch: async () => new Response("ok"),
      createTerminal: () => ({
        async question() {
          throw new Error("chooser must not prompt without choices");
        },
        close() {},
      }),
      writeOutput() {},
      writeError() {},
      async fetch(input) {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input
              : input.url,
        );
        if (url.pathname === "/integral/models")
          return Response.json({ choices: [], current: null });
        throw new Error(`unexpected request: ${url.pathname}`);
      },
    }),
    /no provider and model choices.*integral connection add/,
  );
});

/* @covers CLI-5D8A1C72
Given a user has local authority to operate an Integral deployment
	When the user runs `integral image edit`
		Then Integral opens a temporary working copy of the active Dockerfile in the configured editor
			And validates the resulting recipe and foundational-image boundary before changing canonical state
			And durably commits a changed valid Dockerfile to the host-managed image-recipe repository with the local operator as actor
			And leaves the active recipe unchanged when the editor exits unsuccessfully, the file is unchanged, or validation fails
			And does not create an approval request
	When the user runs `integral image rebuild`
		Then Integral directly starts a fresh build of the active recipe with pull and layer-cache reuse disabled
			And applies the same build isolation, validation, floating dependency resolution, inventory capture, and immutable image selection as an approved rebuild
			And records the local operator, recipe commit, prior image digest, build result, installed package inventory, and resulting image digest in the audit history
			And does not create an approval request
	When the user requests help for `integral image`, `integral image edit`, or `integral image rebuild`
		Then Integral explains that these are privileged local operator actions
			And distinguishes them from Pi and remote automation requests that require approval
			And performs no edit or build
*/
test("[CLI-5D8A1C72] local image edit and rebuild commands execute directly without creating approvals", async (t) => {
  const paths = await fixture(t),
    calls: string[] = [],
    output: string[] = [],
    dependencies = {
      resolvePaths: () => paths,
      loadConfig: () => loadConfig(paths, {}),
      actor: () => "local-human",
      writeOutput: (text: string) => output.push(text),
      async edit(_paths: typeof paths, actor: string) {
        calls.push(`edit:${actor}`);
        return { prior: "old", landed: "new" };
      },
      async rebuild(_paths: typeof paths, _config: unknown, actor: string) {
        calls.push(`rebuild:${actor}`);
        return {
          recipeCommit: "new",
          piVersion: "0.85.0",
          image: "sha256:new-image",
        };
      },
    };
  assert.equal(await imageCommand(["edit"], dependencies), 0);
  assert.equal(await imageCommand(["rebuild"], dependencies), 0);
  assert.deepEqual(calls, ["edit:local-human", "rebuild:local-human"]);
  assert.match(output.join(""), /Updated image Dockerfile to new/);
  assert.match(output.join(""), /Built Pi 0\.85\.0/);
  assert.doesNotMatch(output.join(""), /approval/i);

  output.length = 0;
  assert.equal(await imageCommand(["--help"], dependencies), 0);
  assert.match(output.join(""), /privileged local operator actions/);
  assert.match(output.join(""), /do not create approval requests/);
});
