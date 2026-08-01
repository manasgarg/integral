import assert from "node:assert/strict";
import test from "node:test";
import {
  createTalkTerminal,
  main,
  queueCommand,
  selectAuthentication,
  talkCommand,
} from "../src/cli.ts";
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
    ["queue", "-h"],
    ["queue", "ls", "-h"],
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
  assert.match(result.stdout, /--auth <method>/);
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

test("[CONNECTION-2F7C9A61] non-interactive connection setup requires --auth and names supported choices", async (t) => {
  const paths = await fixture(t),
    result = await capture(["connection", "add", "anthropic"], {
      RR_HOME: paths.root,
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
  assert.equal(value.server.gatewayPort, 7310);
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
      if (url.pathname === "/rr/snapshot")
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
      ["GET", "/rr/snapshot", undefined],
      ["GET", "/rr/snapshot", undefined],
      [
        "PATCH",
        "/rr/queue/message-2",
        JSON.stringify({ text: "revised message" }),
      ],
      ["DELETE", "/rr/queue/message-2", undefined],
    ],
  );
  assert.equal(
    requests.some((request) => request.path === "/rr/events"),
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
    result = await capture(["talk"], { RR_HOME: paths.root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /coordinator is not reachable.*rr server start/);
});

test("[CHAT-888AFAE0] asynchronous events redraw the active prompt and preserve pending input", async () => {
  const actions: string[] = [];
  let finishQuestion!: (answer: string) => void;
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
        moveCursor(_output, offset) {
          actions.push(`move:${offset}`);
        },
      },
    }),
    pending = terminal.question("rr> ");

  terminal.writeEvent!("assistant: hello\n");
  assert.deepEqual(actions, [
    "clear",
    "start",
    "write:assistant: hello\n",
    "write:rr> draft",
    "move:-3",
  ]);

  finishQuestion("done");
  assert.equal(await pending, "done");
  terminal.writeEvent!("assistant: later\n");
  assert.equal(actions.at(-1), "write:assistant: later\n");
});

test("[BOX-E1F472A1] [CHAT-6E91B4C7] [CHAT-888AFAE0] [CHAT-84D839CE] [CHAT-989F5C14] scripted terminal silently reuses the current model on a refreshed runtime before handling local commands", async (t) => {
  const paths = await fixture(t),
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
  const events = new TextEncoder().encode(
    'event: snapshot\ndata: {"conversation":[{"type":"user","text":"persisted"},{"type":"session","text":"hidden"}]}\n\n' +
      'event: conversation.assistant\ndata: {"type":"assistant","text":"response"}\n\n',
  );

  const code = await talkCommand([], {
    resolvePaths: () => paths,
    componentEndpoint: async () => "http://coordinator.test",
    verifiedFetch: async () => new Response("ok"),
    createTerminal: () => ({
      async question(prompt) {
        prompts.push(prompt);
        const line = lines.shift();
        if (line === undefined) throw new Error("EOF");
        return line;
      },
      writeEvent(text) {
        stdout += `[event]${text}`;
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
      if (url.pathname === "/rr/events") return new Response(events);
      if (url.pathname === "/rr/models")
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
      if (url.pathname === "/rr/status")
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
      if (url.pathname === "/rr/snapshot")
        return Response.json({
          queue: [{ id: "message-1", text: "queued", status: "queued" }],
        });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(code, 0);
  assert.ok(prompts.every((prompt) => prompt === "rr> "));
  assert.doesNotMatch(stdout, /Available models/);
  assert.match(stdout, /\[event\]user: persisted/);
  assert.match(stdout, /\[event\]assistant: response/);
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
        "/rr/selection",
        JSON.stringify({ connection: "work", model: "gpt-5.5" }),
      ],
      [
        "PATCH",
        "/rr/queue/message-1",
        JSON.stringify({ text: "revised text" }),
      ],
      ["DELETE", "/rr/queue/message-1", undefined],
      ["POST", "/rr/messages", JSON.stringify({ text: "hello Pi" })],
    ],
  );
});

test("[CHAT-6E91B4C7] [CHAT-C53A90D2] rr talk patterns and /model use one provider-and-model chooser", async (t) => {
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
      if (url.pathname === "/rr/models")
        return Response.json({ choices, current });
      if (url.pathname === "/rr/selection") {
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
      if (url.pathname === "/rr/events") return new Response("");
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
      if (url.pathname === "/rr/models")
        return Response.json({ choices, current });
      if (url.pathname === "/rr/selection") {
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
      if (url.pathname === "/rr/events") return new Response("");
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
  assert.match(stdout, /rr talk <pattern>\.\.\. or \/model <pattern>\.\.\./);
});

test("[CHAT-6E91B4C7] rr talk refuses attachment when no active provider and model choices remain", async (t) => {
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
        if (url.pathname === "/rr/models")
          return Response.json({ choices: [], current: null });
        throw new Error(`unexpected request: ${url.pathname}`);
      },
    }),
    /no provider and model choices.*rr connection add/,
  );
});
