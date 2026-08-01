import type { Component } from "./constants.ts";
import type { IntegralPaths } from "./paths.ts";
import {
  componentIdentity,
  deploymentId,
  internalHeaders,
  readComponentState,
} from "./state.ts";
import { IntegralError } from "./errors.ts";

export async function componentEndpoint(
  paths: IntegralPaths,
  component: Component,
): Promise<string> {
  const state = await readComponentState(paths, component);
  if (!state)
    throw new IntegralError(
      `${component} is not running; run integral server start`,
    );
  return state.endpoint;
}
export async function internalFetch(
  paths: IntegralPaths,
  caller: Component,
  target: Component,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const endpoint = await componentEndpoint(paths, target),
    token = await componentIdentity(paths);
  return fetch(new URL(path, endpoint), {
    ...init,
    headers: {
      ...internalHeaders(caller, token, deploymentId(paths)),
      "content-type": "application/json",
      ...init.headers,
    },
  });
}
export async function verifiedFetch(
  paths: IntegralPaths,
  component: Component,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(
    new URL(path, await componentEndpoint(paths, component)),
    init,
  );
  if (!response.ok)
    throw new IntegralError(`${component} request failed: ${response.status}`);
  const deployment = response.headers.get("content-type")?.includes("json")
    ? ((await response.clone().json()) as { deploymentId?: string })
        .deploymentId
    : undefined;
  if (path.includes("health") && deployment !== deploymentId(paths))
    throw new IntegralError(
      `endpoint does not belong to expected ${component} deployment`,
    );
  return response;
}
