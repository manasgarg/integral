import type { IncomingMessage, ServerResponse } from "node:http";
import { IntegralError } from "./errors.ts";

export interface JsonBodyOptions {
  maxBytes?: number;
  invalidMessage?: string;
}

export async function readRequestBody(
  request: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (
    typeof declared === "string" &&
    /^\d+$/.test(declared) &&
    Number(declared) > maxBytes
  )
    throw new IntegralError("request body is too large", 413);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    bytes += part.byteLength;
    if (bytes > maxBytes)
      throw new IntegralError("request body is too large", 413);
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export async function readJsonObject(
  request: IncomingMessage,
  options: JsonBodyOptions = {},
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(
      (await readRequestBody(request, options.maxBytes)).toString() || "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("JSON body is not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof IntegralError) throw error;
    throw new IntegralError(
      options.invalidMessage ?? "invalid JSON request",
      400,
    );
  }
}

export function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  trailingNewline = true,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}${trailingNewline ? "\n" : ""}`);
}
