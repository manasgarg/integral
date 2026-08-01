import type { LogFormat, LogLevel } from "./config.ts";

const weights: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};
const secretKeys =
  /authorization|cookie|credential|secret|token|password|api[_-]?key|oauth.*code/i;
export const REDACTED = "[REDACTED]";

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export function redact(
  value: unknown,
  knownSecrets: readonly string[] = [],
): unknown {
  if (typeof value === "string") {
    let result = value.replace(/(bearer|basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`);
    for (const secret of knownSecrets)
      if (secret) result = result.split(secret).join(REDACTED);
    return result.replace(/[\r\n]+/g, "\\n");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, knownSecrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        secretKeys.test(key) ? REDACTED : redact(v, knownSecrets),
      ]),
    );
  return value;
}

export interface LogContext {
  message_id?: string;
  session_id?: string;
  request_id?: string;
  [key: string]: unknown;
}
export interface LoggerOptions {
  component: string;
  deploymentId: string;
  level: LogLevel;
  format: LogFormat;
  secrets?: string[];
  sink?: (line: string) => void;
}

export class Logger {
  constructor(private readonly options: LoggerOptions) {}
  event(
    level: LogLevel,
    event: string,
    message: string,
    context: LogContext = {},
  ): void {
    if (weights[level] > weights[this.options.level]) return;
    const item = redact(
      {
        timestamp: new Date().toISOString(),
        level,
        component: this.options.component,
        event,
        message,
        pid: process.pid,
        deployment_id: this.options.deploymentId,
        ...context,
      },
      this.options.secrets,
    ) as Record<string, unknown>;
    const line =
      this.options.format === "json"
        ? JSON.stringify(item)
        : `${textValue(item.timestamp)} ${level.toUpperCase()} ${textValue(item.component)} ${event} ${textValue(item.message)}${Object.keys(context).length ? ` ${JSON.stringify(redact(context, this.options.secrets))}` : ""}`;
    (this.options.sink ?? ((value) => process.stderr.write(value)))(
      `${line}\n`,
    );
  }
}
