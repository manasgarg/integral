import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  completeEmailOptions,
  createTalkTerminal,
  explicitConnection,
  main,
  queueCommand,
  selectAuthentication,
  talkCommand,
} from "../src/cli.ts";
import { fixture } from "./helpers.ts";
import { saveConnection } from "../src/connections.ts";

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
      INTEGRAL_HOME: "relative",
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

test("[CONNECTION-C14B8E70] connection help lists catalog, guided add, list, and removal but no grants", async () => {
  const result = await capture(["connection", "--help"]);
  assert.equal(result.code, 0);
  for (const command of ["catalog", "add", "ls", "rm"])
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  assert.match(result.stdout, /guided setup/);
  assert.match(result.stdout, /--auth <method>/);
  assert.doesNotMatch(result.stdout, /^\s+(grant|revoke)\b/m);
});

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

test("[CONNECTION-512D9A25] unsupported authentication is rejected before creating a declaration", async (t) => {
  const paths = await fixture(t),
    result = await capture(
      ["connection", "add", "anthropic", "--auth", "none"],
      { INTEGRAL_HOME: paths.root },
    );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not supported/);
});

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
    env = { INTEGRAL_HOME: paths.root };
  assert.equal(
    (await capture(["config", "path"], env)).stdout.trim(),
    paths.mainConfig,
  );
  assert.equal((await capture(["config", "init"], env)).code, 0);
  assert.equal((await capture(["config", "init"], env)).code, 1);
});

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

test("[CHAT-84D839CE] talk help documents every local command and never contacts Pi", async () => {
  const result = await capture(["talk", "--help"]);
  for (const command of [
    "/help",
    "/status",
    "/model",
    "/queue ls",
    "/queue edit",
    "/queue delete",
    "/exit",
  ])
    assert.match(result.stdout, new RegExp(command.replace("/", "\\/")));
});

test("[CHAT-DB0EF523] talk refuses to start an ungoverned Pi when no coordinator is discoverable", async (t) => {
  const paths = await fixture(t),
    result = await capture(["talk"], { INTEGRAL_HOME: paths.root });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /coordinator is not reachable.*integral server start/,
  );
});

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

test("[BOX-E1F472A1] [CHAT-6E91B4C7] [CHAT-888AFAE0] [CHAT-84D839CE] [CHAT-989F5C14] scripted terminal silently reuses the current model on a refreshed runtime before handling local commands", async (t) => {
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
      if (url.pathname === "/integral/events") return new Response(events);
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
        "/integral/messages",
        JSON.stringify({ text: "hello Pi", terminalId: "terminal-test" }),
      ],
    ],
  );
});

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
        if (eventCalls++ === 0) return new Response(firstEvents);
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
        return new Response(stream);
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
      if (url.pathname === "/integral/events") return new Response("");
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
      if (url.pathname === "/integral/events") return new Response("");
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
