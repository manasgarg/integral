import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/cli.ts";
import { fixture } from "./helpers.ts";

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

test("[ENV-0E6A92C4] help, version, and catalog do not resolve invalid deployment state", async () => {
  for (const args of [["--help"], ["version"], ["connection", "catalog"]]) {
    const result = await capture(args, {
      RR_HOME: "relative",
      HOME: undefined,
    });
    assert.equal(result.code, 0, result.stderr);
  }
});

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
    ["talk", "-h"],
  ]) {
    const result = await capture(args, {
      RR_HOME: "relative",
      HOME: undefined,
    });
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/, args.join(" "));
    assert.equal(result.stderr, "", args.join(" "));
  }
});

test("[CONNECTION-C14B8E70] connection help lists catalog, guided add, list, and removal but no grants", async () => {
  const result = await capture(["connection", "--help"]);
  assert.equal(result.code, 0);
  for (const command of ["catalog", "add", "ls", "rm"])
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  assert.match(result.stdout, /guided setup/);
  assert.doesNotMatch(result.stdout, /^\s+(grant|revoke)\b/m);
});

test("[CONNECTION-75EC27E8] catalog describes model, HTTP, MCP and every supported authentication family", async () => {
  const result = await capture(["connection", "catalog"]);
  for (const word of [
    "openai-codex",
    "anthropic",
    "http",
    "mcp",
    "model",
    "oauth",
    "device-code",
    "key",
    "none",
  ])
    assert.match(result.stdout, new RegExp(word));
});

test("[CONNECTION-A61E2C9D] [CONNECTION-E73B40C6] explicit no-auth HTTP setup and listing work end-to-end", async (t) => {
  const paths = await fixture(t),
    env = { RR_HOME: paths.root };
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

test("[CONNECTION-512D9A25] unsupported authentication is rejected before creating a declaration", async (t) => {
  const paths = await fixture(t),
    result = await capture(
      ["connection", "add", "anthropic", "--auth", "none"],
      { RR_HOME: paths.root },
    );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not support|do not support/);
});

test("[CONNECTION-B4E83C2D] bare Anthropic setup selects OAuth rather than credential entry", async (t) => {
  const paths = await fixture(t),
    result = await capture(["connection", "add", "anthropic"], {
      RR_HOME: paths.root,
    });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OAuth setup requires an interactive terminal/);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /Credential \(hidden/,
  );
});

test("[CONNECTION-03C4E791] bare add clearly requires the guided interactive terminal", async (t) => {
  const paths = await fixture(t),
    result = await capture(["connection", "add"], { RR_HOME: paths.root });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /guided connection setup requires an interactive terminal/,
  );
});

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
      { RR_HOME: paths.root },
    );
  assert.equal(result.code, 1);
  const ls = await capture(["connection", "ls", "--json"], {
    RR_HOME: paths.root,
  });
  assert.deepEqual(JSON.parse(ls.stdout), []);
});

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

test("[CONFIG-17D6C8A4] [CONFIG-C41E8B75] config path and init use only the resolved deployment", async (t) => {
  const paths = await fixture(t),
    env = { RR_HOME: paths.root };
  assert.equal(
    (await capture(["config", "path"], env)).stdout.trim(),
    paths.mainConfig,
  );
  assert.equal((await capture(["config", "init"], env)).code, 0);
  assert.equal((await capture(["config", "init"], env)).code, 1);
});

test("[CONFIG-B93A4E70] [CONFIG-D4A70C31] validate and show offer equivalent machine-readable configuration", async (t) => {
  const paths = await fixture(t),
    env = { RR_HOME: paths.root };
  const valid = await capture(["config", "validate", "--json"], env);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  const shown = await capture(["config", "show", "--json"], env);
  const value = JSON.parse(shown.stdout);
  assert.equal(value.server.gatewayPort, 7300);
  assert.equal(value.sources["server.gateway_port"], "built-in");
});

test("[CONFIG-D4A70C31] human config output uses readable sourced sections instead of inline JSON", async (t) => {
  const paths = await fixture(t),
    shown = await capture(["config", "show"], {
      RR_HOME: paths.root,
      RR_GATEWAY_PORT: "7400",
    });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^Effective configuration$/m);
  assert.match(shown.stdout, /^\[server\]$/m);
  assert.match(shown.stdout, /^gateway_port = 7400 {2}# source: environment$/m);
  assert.match(shown.stdout, /^\[runner\]$/m);
  assert.match(shown.stdout, /^\[connections\]\nnames = \[\]$/m);
  assert.doesNotMatch(shown.stdout, /^server: \{/m);
});

test("[SERVER-2C8F41A7] component startup help documents combined and three separate modes", async () => {
  const result = await capture(["server", "start", "--help"]);
  for (const word of [
    "Combined mode",
    "--component",
    "coordinator",
    "runner",
    "gateway",
  ])
    assert.match(result.stdout, new RegExp(word));
});

test("[CHAT-84D839CE] talk help documents every local command and never contacts Pi", async () => {
  const result = await capture(["talk", "--help"]);
  for (const command of [
    "/help",
    "/status",
    "/queue ls",
    "/queue edit",
    "/queue delete",
    "/exit",
  ])
    assert.match(result.stdout, new RegExp(command.replace("/", "\\/")));
});

test("[CHAT-DB0EF523] talk refuses to start an ungoverned Pi when no coordinator is discoverable", async (t) => {
  const paths = await fixture(t),
    result = await capture(["talk"], { RR_HOME: paths.root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /coordinator is not reachable.*rr server start/);
});

test("[CHAT-888AFAE0] terminal chat contract uses a stable prompt and submits non-empty lines through the coordinator API", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/cli.ts", "utf8"),
  );
  assert.match(source, /question\("rr> "\)/);
  assert.match(source, /if \(!text\) continue/);
  assert.match(source, /\/rr\/messages/);
});

test("[CHAT-989F5C14] local status is served by the coordinator without exposing credentials", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/coordinator.ts", "utf8"),
  );
  assert.match(
    source,
    /gateway.*runner.*container.*session.*provider.*queueDepth.*inFlight.*attached/s,
  );
  assert.doesNotMatch(source, /credentialFor/);
});
