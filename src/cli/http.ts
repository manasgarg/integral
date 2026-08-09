import { IntegralError } from "../errors.ts";

export async function fetchJson(
  url: URL,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, init);
  if (!response.ok)
    throw new IntegralError(
      ((await response.json()) as { error?: string }).error ??
        `request failed: ${response.status}`,
    );
  return response.json();
}

export async function requestOk(
  url: URL,
  init: RequestInit,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetcher(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new IntegralError(body.error ?? `request failed: ${response.status}`);
  }
}

export async function requestJson(
  url: URL,
  init: RequestInit,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<unknown> {
  const response = await fetcher(url, init),
    body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok)
    throw new IntegralError(
      body && typeof body === "object" && "error" in body
        ? String(body.error)
        : `request failed: ${response.status}`,
    );
  return body;
}
