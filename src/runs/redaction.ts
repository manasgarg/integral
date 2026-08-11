const sensitiveKey =
  /authorization|cookie|credential|secret|password|api[_-]?key|oauth.*code|(?:access|refresh|session)[_-]?token/i;

export function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, candidate]) => [
      key,
      sensitiveKey.test(key) ? "[redacted]" : redact(candidate, secrets),
    ]),
  );
}

export function redactText(value: string, secrets: string[]): string {
  let result = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi,
    "$1[redacted]@",
  );
  result = result.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    "$1 [redacted]",
  );
  for (const secret of secrets)
    if (secret) result = result.split(secret).join("[redacted]");
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
