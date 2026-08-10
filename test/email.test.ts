import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { writeEmailExtension } from "../src/container.ts";
import { validateConnection, type Connection } from "../src/connections.ts";
import { executeEmail, type EmailFetch } from "../src/email.ts";
import { fixture } from "./helpers.ts";

function gmail(capabilities: string[]): Connection {
  return validateConnection({
    name: "work-mail",
    kind: "email",
    provider: "gmail",
    auth: "oauth",
    account: "me@example.com",
    client_id: "public-client",
    capabilities,
    ...(capabilities.includes("send")
      ? { allowed_recipients: ["friend@example.com", "*@company.example"] }
      : {}),
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* @covers EMAIL-276B27AA
Given an active Gmail connection enables `search` or `read`
	When Pi searches the account with a Gmail query
		Then trusted host code returns a bounded list of matching message summaries
			And does not modify mailbox state
	When Pi reads a message by its Gmail message ID
		Then trusted host code returns its headers and bounded text content
			And does not modify mailbox state
	When Pi requests a read or search operation that the connection did not enable
		Then the host refuses the operation without contacting Gmail
*/
test("[EMAIL-276B27AA] Gmail search returns bounded message summaries without mutation", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const request: EmailFetch = async (input, init) => {
    const url = input.toString();
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("?q="))
      return json({ messages: [{ id: "m1", threadId: "t1" }] });
    return json({
      id: "m1",
      threadId: "t1",
      snippet: "Hello",
      payload: {
        headers: [
          { name: "From", value: "friend@example.com" },
          { name: "Subject", value: "News" },
        ],
      },
    });
  };
  const result = (await executeEmail(
    gmail(["search"]),
    "access-token",
    { operation: "search", query: "is:unread", maxResults: 500 },
    request,
  )) as { messages: Array<{ id: string; subject: string }> };
  assert.deepEqual(result.messages, [
    {
      id: "m1",
      threadId: "t1",
      from: "friend@example.com",
      to: "",
      subject: "News",
      date: "",
      snippet: "Hello",
    },
  ]);
  assert.match(calls[0]!.url, /maxResults=20/);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET"],
  );
});

test("[EMAIL-276B27AA] Gmail read returns bounded text without changing mailbox state", async () => {
  const calls: RequestInit[] = [];
  const result = (await executeEmail(
    gmail(["read"]),
    "access-token",
    { operation: "read", messageId: "abc_123" },
    async (_input, init) => {
      calls.push(init ?? {});
      return json({
        id: "abc_123",
        payload: {
          headers: [{ name: "Subject", value: "A message" }],
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("message body").toString("base64url") },
            },
          ],
        },
      });
    },
  )) as { text: string; subject: string; truncated: boolean };
  assert.equal(result.text, "message body");
  assert.equal(result.subject, "A message");
  assert.equal(result.truncated, false);
  assert.equal(calls[0]!.method, undefined);
});

test("[EMAIL-276B27AA] disabled Gmail operations are refused before provider access", async () => {
  let calls = 0;
  await assert.rejects(
    executeEmail(
      gmail(["read"]),
      "access-token",
      { operation: "search", query: "from:anyone@example.com" },
      async () => {
        calls++;
        return json({});
      },
    ),
    /does not enable search/,
  );
  assert.equal(calls, 0);
});

/* @covers EMAIL-19BA105D
Given an active Gmail or Mailgun connection enables `send`
	When Pi submits a text email whose recipients match that connection's policy
		Then trusted host code fixes the From identity to the configured account
			And sends through the configured provider API
			And returns the provider's message identity
	When any To, Cc, or Bcc recipient is outside the connection's policy
		Then the host refuses the entire message without contacting the provider
	When a message contains an invalid address, header injection, or exceeds a bounded field limit
		Then the host refuses the entire message without contacting the provider
	When the provider rejects a valid constrained message
		Then the host reports its HTTP status and bounded provider reason
			And does not expose credentials or an unbounded response body
*/
test("[EMAIL-19BA105D] Gmail send fixes From and returns the provider identity", async () => {
  let raw = "";
  const result = await executeEmail(
    gmail(["send"]),
    "access-token",
    {
      operation: "send",
      to: ["friend@example.com"],
      cc: ["person@company.example"],
      subject: "Hello",
      text: "Plain text body",
    },
    async (input, init) => {
      assert.match(input.toString(), /gmail\/v1\/users\/me\/messages\/send$/);
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer access-token",
      );
      const body = init?.body;
      if (typeof body !== "string") assert.fail("expected a JSON request body");
      raw = JSON.parse(body).raw;
      return json({ id: "sent-1", threadId: "thread-1" });
    },
  );
  const mime = Buffer.from(raw, "base64url").toString();
  assert.match(mime, /^From: me@example\.com\r\n/);
  assert.match(mime, /To: friend@example\.com/);
  assert.deepEqual(result, { id: "sent-1", threadId: "thread-1" });
});

test("[EMAIL-19BA105D] recipient policy and header validation fail before provider access", async () => {
  let calls = 0;
  const request: EmailFetch = async () => {
    calls++;
    return json({});
  };
  for (const operation of [
    {
      operation: "send" as const,
      to: ["stranger@outside.example"],
      subject: "Hello",
      text: "Body",
    },
    {
      operation: "send" as const,
      to: ["friend@example.com"],
      subject: "Hello\r\nBcc: victim@example.com",
      text: "Body",
    },
  ])
    await assert.rejects(
      executeEmail(gmail(["send"]), "access-token", operation, request),
    );
  assert.equal(calls, 0);
});

test("[EMAIL-19BA105D] Mailgun sends through its configured region with fixed From and Basic authentication", async () => {
  const connection = validateConnection({
    name: "transactional",
    kind: "email",
    provider: "mailgun",
    auth: "key",
    capabilities: ["send"],
    domain: "mg.example.com",
    from_address: "robot@mg.example.com",
    region: "eu",
    allowed_recipients: ["*@example.com"],
  });
  const result = await executeEmail(
    connection,
    "domain-key",
    {
      operation: "send",
      to: ["person@example.com"],
      subject: "Receipt",
      text: "Thanks",
    },
    async (input, init) => {
      assert.equal(
        input.toString(),
        "https://api.eu.mailgun.net/v3/mg.example.com/messages",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Basic ${Buffer.from("api:domain-key").toString("base64")}`,
      );
      const form = init?.body as FormData;
      assert.equal(form.get("from"), "robot@mg.example.com");
      assert.equal(form.get("to"), "person@example.com");
      return json({ id: "mailgun-1", message: "Queued" });
    },
  );
  assert.deepEqual(result, { id: "mailgun-1", message: "Queued" });
});

test("[EMAIL-19BA105D] provider rejection reports a bounded reason without copying secret response fields", async () => {
  const connection = validateConnection({
    name: "transactional",
    kind: "email",
    provider: "mailgun",
    auth: "key",
    capabilities: ["send"],
    domain: "mg.example.com",
    from_address: "robot@mg.example.com",
    allowed_recipients: ["person@example.com"],
  });
  await assert.rejects(
    executeEmail(
      connection,
      "domain-key",
      {
        operation: "send",
        to: ["person@example.com"],
        subject: "Hello",
        text: "Body",
      },
      async () =>
        json(
          {
            message: "Domain is not permitted\ncontact support",
            api_key: "must-not-appear",
          },
          403,
        ),
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /HTTP 403: Domain is not permitted contact support/,
      );
      assert.doesNotMatch(error.message, /must-not-appear|domain-key/);
      return true;
    },
  );
});

/* @covers EMAIL-89334867
Given one or more active email connections exist when a Pi session starts
	When the runner prepares the session home
		Then it registers tools only for capabilities enabled by those connections
			And each tool calls the authenticated host email boundary
			And the host-boundary call bypasses environment proxy dispatch
			And no real email credential is written to the session home
	When the runner prepares a fresh isolated scheduled-task session
		Then it installs the same governed email capabilities in that task home
			And keeps the interactive and scheduled-task session identities separate
	When no active email connection exists
		Then the runner does not install the email extension
	When the semantic tool cannot reach the authenticated host email boundary
		Then it reports whether the request was cancelled or a bounded transport error code
			And does not expose the session credential
*/
test("[EMAIL-89334867] email extension contains only enabled semantic tools and session authentication", async (t) => {
  const paths = await fixture(t),
    home = join(paths.root, "session");
  await writeEmailExtension(home, [gmail(["read", "send"])]);
  const source = await readFile(
    join(home, ".pi", "agent", "extensions", "integral-email.ts"),
    "utf8",
  );
  assert.match(source, /integral\/email/);
  assert.match(source, /from "node:http"/);
  assert.match(source, /proxy-authorization/);
  assert.match(source, /request\(target\.url, \{ agent: false/);
  assert.match(source, /"capabilities":\["read","send"\]/);
  assert.match(source, /email gateway request was cancelled/);
  assert.match(source, /email gateway request failed/);
  assert.doesNotMatch(source, /await fetch/);
  assert.doesNotMatch(source, /access-token|domain-key/);
});

test("[EMAIL-89334867] no email extension is installed without an active email connection", async (t) => {
  const paths = await fixture(t),
    home = join(paths.root, "empty-session"),
    file = join(home, ".pi", "agent", "extensions", "integral-email.ts");
  await writeEmailExtension(home, []);
  await assert.rejects(stat(file), { code: "ENOENT" });
});
