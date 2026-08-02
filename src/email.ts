import type { Connection } from "./connections.ts";
import { IntegralError } from "./errors.ts";

const MAX_RESULTS = 20;
const MAX_RECIPIENTS = 50;
const MAX_SUBJECT_BYTES = 998;
const MAX_BODY_BYTES = 100_000;
const MAX_READ_BYTES = 200_000;
const addressPattern = /^[^\s<>@,;]+@[^\s<>@,;]+$/;

export type EmailOperation =
  | { operation: "search"; query: string; maxResults?: number }
  | { operation: "read"; messageId: string }
  | {
      operation: "send";
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      text: string;
    };

export type EmailFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface GmailHeader {
  name?: unknown;
  value?: unknown;
}

interface GmailPart {
  mimeType?: unknown;
  body?: { data?: unknown };
  parts?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new IntegralError(
      `email provider request failed: HTTP ${response.status}`,
    );
  return record(await response.json());
}

function requireCapability(connection: Connection, capability: string): void {
  if (!connection.capabilities?.includes(capability as never))
    throw new IntegralError(
      `email connection ${connection.name} does not enable ${capability}`,
      403,
    );
}

function providerHeaders(
  connection: Connection,
  credential: string,
): HeadersInit {
  return connection.provider === "mailgun"
    ? {
        authorization: `Basic ${Buffer.from(`api:${credential}`).toString("base64")}`,
      }
    : { authorization: `Bearer ${credential}` };
}

function headersOf(message: Record<string, unknown>): Record<string, string> {
  const payload = record(message.payload);
  const headers = Array.isArray(payload.headers)
    ? (payload.headers as GmailHeader[])
    : [];
  const result: Record<string, string> = {};
  for (const header of headers) {
    if (typeof header.name === "string" && typeof header.value === "string")
      result[header.name.toLowerCase()] = header.value;
  }
  return result;
}

function decodePart(part: GmailPart): string | undefined {
  if (part.mimeType === "text/plain" && typeof part.body?.data === "string")
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const decoded = decodePart(record(child));
      if (decoded !== undefined) return decoded;
    }
  }
  return undefined;
}

function gmailSummary(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const headers = headersOf(message);
  return {
    id: typeof message.id === "string" ? message.id : "",
    threadId: typeof message.threadId === "string" ? message.threadId : "",
    from: headers.from ?? "",
    to: headers.to ?? "",
    subject: headers.subject ?? "",
    date: headers.date ?? "",
    snippet: typeof message.snippet === "string" ? message.snippet : "",
  };
}

function validateField(name: string, value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new IntegralError(`${name} must not be empty`);
  if (/\r|\n/.test(value) || Buffer.byteLength(value) > maxBytes)
    throw new IntegralError(`${name} is invalid or too long`);
  return value;
}

function allowedRecipient(connection: Connection, recipient: string): boolean {
  const normalized = recipient.toLowerCase();
  return (connection.allowedRecipients ?? []).some((rule) =>
    rule.startsWith("*@")
      ? normalized.endsWith(`@${rule.slice(2)}`)
      : normalized === rule,
  );
}

function validateMessage(
  connection: Connection,
  operation: Extract<EmailOperation, { operation: "send" }>,
): {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
} {
  const to = operation.to,
    cc = operation.cc ?? [],
    bcc = operation.bcc ?? [],
    recipients = [...to, ...cc, ...bcc];
  if (!to.length || recipients.length > MAX_RECIPIENTS)
    throw new IntegralError(
      `email must have 1 to ${MAX_RECIPIENTS} recipients`,
    );
  if (
    recipients.some(
      (recipient) =>
        typeof recipient !== "string" ||
        !addressPattern.test(recipient) ||
        /\r|\n/.test(recipient),
    )
  )
    throw new IntegralError("email contains an invalid recipient address");
  const denied = recipients.find(
    (recipient) => !allowedRecipient(connection, recipient),
  );
  if (denied)
    throw new IntegralError(
      `recipient is not allowed by connection ${connection.name}: ${denied}`,
      403,
    );
  const subject = validateField(
    "subject",
    operation.subject,
    MAX_SUBJECT_BYTES,
  );
  if (typeof operation.text !== "string" || !operation.text.trim())
    throw new IntegralError("text must not be empty");
  if (Buffer.byteLength(operation.text) > MAX_BODY_BYTES)
    throw new IntegralError("text is too long");
  return { to, cc, bcc, subject, text: operation.text };
}

function mimeMessage(
  from: string,
  message: ReturnType<typeof validateMessage>,
): string {
  const rows = [
    `From: ${from}`,
    `To: ${message.to.join(", ")}`,
    ...(message.cc.length ? [`Cc: ${message.cc.join(", ")}`] : []),
    ...(message.bcc.length ? [`Bcc: ${message.bcc.join(", ")}`] : []),
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    message.text,
  ];
  return rows.join("\r\n");
}

async function gmail(
  connection: Connection,
  credential: string,
  operation: EmailOperation,
  request: EmailFetch,
): Promise<unknown> {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  const headers = providerHeaders(connection, credential);
  if (operation.operation === "search") {
    requireCapability(connection, "search");
    if (typeof operation.query !== "string" || operation.query.length > 1_000)
      throw new IntegralError("search query is invalid or too long");
    const maxResults = Math.min(
      MAX_RESULTS,
      Math.max(1, Math.trunc(operation.maxResults ?? 10)),
    );
    const url = new URL(base);
    url.searchParams.set("q", operation.query);
    url.searchParams.set("maxResults", String(maxResults));
    const listed = await responseJson(await request(url, { headers }));
    const messages = Array.isArray(listed.messages) ? listed.messages : [];
    const summaries = [];
    for (const item of messages.slice(0, maxResults)) {
      const id = record(item).id;
      if (typeof id !== "string") continue;
      const detail = await responseJson(
        await request(
          `${base}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers },
        ),
      );
      summaries.push(gmailSummary(detail));
    }
    return { messages: summaries, nextPageToken: listed.nextPageToken ?? null };
  }
  if (operation.operation === "read") {
    requireCapability(connection, "read");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operation.messageId))
      throw new IntegralError("invalid Gmail message ID");
    const message = await responseJson(
      await request(
        `${base}/${encodeURIComponent(operation.messageId)}?format=full`,
        { headers },
      ),
    );
    const text = decodePart(record(message.payload)) ?? "";
    return {
      ...gmailSummary(message),
      text: Buffer.from(text).subarray(0, MAX_READ_BYTES).toString(),
      truncated: Buffer.byteLength(text) > MAX_READ_BYTES,
    };
  }
  requireCapability(connection, "send");
  const message = validateMessage(connection, operation);
  const raw = Buffer.from(mimeMessage(connection.account!, message)).toString(
    "base64url",
  );
  const sent = await responseJson(
    await request(`${base}/send`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    }),
  );
  return { id: sent.id ?? null, threadId: sent.threadId ?? null };
}

async function mailgun(
  connection: Connection,
  credential: string,
  operation: EmailOperation,
  request: EmailFetch,
): Promise<unknown> {
  if (operation.operation !== "send")
    throw new IntegralError("mailgun supports only send", 403);
  requireCapability(connection, "send");
  const message = validateMessage(connection, operation),
    form = new FormData();
  form.set("from", connection.fromAddress!);
  for (const recipient of message.to) form.append("to", recipient);
  for (const recipient of message.cc) form.append("cc", recipient);
  for (const recipient of message.bcc) form.append("bcc", recipient);
  form.set("subject", message.subject);
  form.set("text", message.text);
  const host =
    connection.region === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
  const sent = await responseJson(
    await request(
      `https://${host}/v3/${encodeURIComponent(connection.domain!)}/messages`,
      {
        method: "POST",
        headers: providerHeaders(connection, credential),
        body: form,
      },
    ),
  );
  return { id: sent.id ?? null, message: sent.message ?? null };
}

export async function executeEmail(
  connection: Connection,
  credential: string | undefined,
  operation: EmailOperation,
  request: EmailFetch = globalThis.fetch,
): Promise<unknown> {
  if (connection.kind !== "email")
    throw new IntegralError("connection is not an email account", 400);
  if (!credential)
    throw new IntegralError(
      `connection ${connection.name} has no usable credential; rotate or reconfigure it`,
      403,
    );
  return connection.provider === "gmail"
    ? gmail(connection, credential, operation, request)
    : mailgun(connection, credential, operation, request);
}

export function parseEmailOperation(raw: unknown): EmailOperation {
  const value = record(raw),
    operation = value.operation;
  if (operation === "search")
    return {
      operation,
      query: typeof value.query === "string" ? value.query : "",
      ...(typeof value.maxResults === "number"
        ? { maxResults: value.maxResults }
        : {}),
    };
  if (operation === "read")
    return {
      operation,
      messageId: typeof value.messageId === "string" ? value.messageId : "",
    };
  if (operation === "send")
    return {
      operation,
      to: Array.isArray(value.to) ? (value.to as string[]) : [],
      ...(Array.isArray(value.cc) ? { cc: value.cc as string[] } : {}),
      ...(Array.isArray(value.bcc) ? { bcc: value.bcc as string[] } : {}),
      subject: typeof value.subject === "string" ? value.subject : "",
      text: typeof value.text === "string" ? value.text : "",
    };
  throw new IntegralError("unknown email operation");
}
