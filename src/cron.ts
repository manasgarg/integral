import { IntegralError } from "./errors.ts";

interface CronField {
  wildcard: boolean;
  values: Set<number>;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function field(
  source: string,
  minimum: number,
  maximum: number,
  name: string,
  normalize: (value: number) => number = (value) => value,
): CronField {
  const values = new Set<number>();
  for (const item of source.split(",")) {
    const [rangeSource, stepSource] = item.split("/");
    if (!rangeSource || item.split("/").length > 2)
      throw new IntegralError(`invalid cron ${name}: ${source}`);
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step < 1)
      throw new IntegralError(`invalid cron ${name} step: ${source}`);
    let start: number, end: number;
    if (rangeSource === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeSource.includes("-")) {
      const parts = rangeSource.split("-");
      if (parts.length !== 2) throw new IntegralError(`invalid cron ${name}`);
      start = Number(parts[0]);
      end = Number(parts[1]);
    } else {
      start = Number(rangeSource);
      end = start;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    )
      throw new IntegralError(
        `cron ${name} must be between ${minimum} and ${maximum}`,
      );
    for (let value = start; value <= end; value += step)
      values.add(normalize(value));
  }
  if (!values.size) throw new IntegralError(`cron ${name} is empty`);
  return { wildcard: source === "*", values };
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new IntegralError("cron expression must contain five fields");
  return {
    minute: field(parts[0]!, 0, 59, "minute"),
    hour: field(parts[1]!, 0, 23, "hour"),
    dayOfMonth: field(parts[2]!, 1, 31, "day of month"),
    month: field(parts[3]!, 1, 12, "month"),
    dayOfWeek: field(parts[4]!, 0, 7, "day of week", (value) =>
      value === 7 ? 0 : value,
    ),
  };
}

function partsAt(timestamp: number, timezone: string): Record<string, number> {
  let formatted: Intl.DateTimeFormatPart[];
  try {
    formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      minute: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      day: "numeric",
      month: "numeric",
      year: "numeric",
      weekday: "short",
    }).formatToParts(timestamp);
  } catch {
    throw new IntegralError(`invalid IANA timezone: ${timezone}`);
  }
  const result: Record<string, number> = {};
  for (const part of formatted)
    if (part.type !== "literal" && part.type !== "weekday")
      result[part.type] = Number(part.value);
  const weekday = formatted.find((part) => part.type === "weekday")?.value;
  result.weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    weekday ?? "",
  );
  return result;
}

export function cronMatches(
  parsed: ParsedCron,
  timezone: string,
  timestamp: number,
): boolean {
  const local = partsAt(timestamp, timezone),
    dayOfMonth = parsed.dayOfMonth.values.has(local.day!),
    dayOfWeek = parsed.dayOfWeek.values.has(local.weekday!),
    dayMatches =
      parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard
        ? true
        : parsed.dayOfMonth.wildcard
          ? dayOfWeek
          : parsed.dayOfWeek.wildcard
            ? dayOfMonth
            : dayOfMonth || dayOfWeek;
  return (
    parsed.minute.values.has(local.minute!) &&
    parsed.hour.values.has(local.hour!) &&
    parsed.month.values.has(local.month!) &&
    dayMatches
  );
}

const SEARCH_MINUTES = 366 * 24 * 60 * 8;

export function nextCronInstant(
  expression: string,
  timezone: string,
  after: number,
): number {
  const parsed = parseCron(expression);
  partsAt(after, timezone);
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (
    let checked = 0;
    checked < SEARCH_MINUTES;
    checked++, candidate += 60_000
  )
    if (cronMatches(parsed, timezone, candidate)) return candidate;
  throw new IntegralError(
    "cron expression has no occurrence in the supported search horizon",
  );
}
