import { IntegralError } from "../errors.ts";
import { componentEndpoint, verifiedFetch } from "../http-client.ts";
import type { ModelSelection } from "../model-selection.ts";
import type { IntegralPaths } from "../paths.ts";
import { resolvePaths } from "../paths.ts";
import { fetchJson, requestJson } from "./http.ts";

const STATUS_HELP = `Usage: integral status [--json]

Show the shared conversation and component status. In integral talk, use /status.
`;

const APPROVAL_HELP = `Usage: integral approval <command>

Commands:
  ls [--json]             list governed requests awaiting a human
  approve <id> [--json]   approve one governed request
  deny <id> [--json]      deny one governed request

In integral talk, use /approvals, /approve <id>, or /deny <id>.
`;

export interface ConversationCommandDependencies {
  resolvePaths(): IntegralPaths;
  componentEndpoint: typeof componentEndpoint;
  verifiedFetch: typeof verifiedFetch;
  fetch: typeof globalThis.fetch;
  writeOutput(text: string): void;
}

export interface ConversationOperationDependencies {
  fetch: typeof globalThis.fetch;
  writeOutput(text: string): void;
}

const productionDependencies: ConversationCommandDependencies = {
  resolvePaths,
  componentEndpoint,
  verifiedFetch,
  fetch: globalThis.fetch,
  writeOutput: (text) => process.stdout.write(text),
};

export async function healthyCoordinator(
  dependencies: Pick<
    ConversationCommandDependencies,
    "resolvePaths" | "componentEndpoint" | "verifiedFetch"
  >,
): Promise<string> {
  const paths = dependencies.resolvePaths();
  try {
    const endpoint = await dependencies.componentEndpoint(paths, "coordinator");
    await dependencies.verifiedFetch(paths, "coordinator", "/integral/health");
    return endpoint;
  } catch {
    throw new IntegralError(
      "coordinator is not reachable; start it with integral server start",
    );
  }
}

interface ConversationStatus {
  gateway: string;
  runner: string;
  scheduler: string;
  container: string;
  session: string | null;
  selection: ModelSelection | null;
  queueDepth: number;
  inFlight: string | null;
  attached: number;
  taskQueueDepth: number;
  taskInFlight: string | null;
}

function renderStatus(status: ConversationStatus): string {
  const selection = status.selection
    ? `${status.selection.connection} (${status.selection.provider}) / ${status.selection.model}`
    : "selection required";
  return [
    `gateway: ${status.gateway}`,
    `runner: ${status.runner}`,
    `scheduler: ${status.scheduler}`,
    `container: ${status.container}`,
    `model: ${selection}`,
    `session: ${status.session ?? "none"}`,
    `queue: ${status.queueDepth} queued, in-flight ${status.inFlight ?? "none"}`,
    `terminals: ${status.attached} attached`,
    `tasks: ${status.taskQueueDepth} queued, in-flight ${status.taskInFlight ?? "none"}`,
    "",
  ].join("\n");
}

export async function runStatusCommand(
  args: string[],
  endpoint: string,
  dependencies: ConversationOperationDependencies,
): Promise<number> {
  const status = (await fetchJson(
    new URL("/integral/status", endpoint),
    dependencies.fetch,
  )) as ConversationStatus;
  dependencies.writeOutput(
    args.includes("--json")
      ? `${JSON.stringify(status, null, 2)}\n`
      : renderStatus(status),
  );
  return 0;
}

export async function statusCommand(
  args: string[],
  overrides: Partial<ConversationCommandDependencies> = {},
): Promise<number> {
  const dependencies = { ...productionDependencies, ...overrides };
  if (args.includes("--help") || args.includes("-h")) {
    dependencies.writeOutput(STATUS_HELP);
    return 0;
  }
  return runStatusCommand(
    args,
    await healthyCoordinator(dependencies),
    dependencies,
  );
}

export function renderApproval(value: Record<string, unknown>): string {
  const id = typeof value.id === "string" ? value.id : "unknown",
    status = typeof value.status === "string" ? value.status : "unknown",
    summary = typeof value.summary === "string" ? value.summary : "request",
    details =
      value.details && typeof value.details === "object"
        ? (value.details as Record<string, unknown>)
        : undefined,
    diff = typeof details?.diff === "string" ? details.diff.trim() : "";
  const floating = details?.floatingResolution === true,
    priorImage =
      typeof details?.priorImage === "string" ? details.priorImage : "unknown";
  return `approval ${id} [${status}] ${summary}${floating ? `\nFloating dependencies will resolve at build time; prior image: ${priorImage}` : ""}${diff ? `\n${diff}` : ""}`;
}

export async function runApprovalCommand(
  args: string[],
  endpoint: string,
  dependencies: ConversationOperationDependencies,
  identity: { attachmentId?: string; localOperator?: boolean },
): Promise<number> {
  const command = args[0],
    json = args.includes("--json");
  if (command === "ls") {
    const approvals = (await fetchJson(
      new URL("/integral/approvals", endpoint),
      dependencies.fetch,
    )) as Array<Record<string, unknown>>;
    if (json)
      dependencies.writeOutput(`${JSON.stringify(approvals, null, 2)}\n`);
    else if (!approvals.length)
      dependencies.writeOutput("No approval requests.\n");
    else
      for (const approval of approvals)
        dependencies.writeOutput(`${renderApproval(approval)}\n`);
    return 0;
  }
  if (command === "approve" || command === "deny") {
    const id = args[1];
    if (!id)
      throw new IntegralError(`usage: integral approval ${command} <id>`);
    const result = (await requestJson(
      new URL(
        `/integral/approvals/${encodeURIComponent(id)}/${command}`,
        endpoint,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          identity.localOperator
            ? { actor: "operator" }
            : { attachmentId: identity.attachmentId },
        ),
      },
      dependencies.fetch,
    )) as Record<string, unknown>;
    dependencies.writeOutput(
      json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${renderApproval(result)}\n`,
    );
    return 0;
  }
  throw new IntegralError(`unknown approval command: ${String(command)}`);
}

export async function approvalCommand(
  args: string[],
  overrides: Partial<ConversationCommandDependencies> = {},
): Promise<number> {
  const dependencies = { ...productionDependencies, ...overrides };
  if (
    !args[0] ||
    args.includes("--help") ||
    args.includes("-h") ||
    args[0] === "help"
  ) {
    dependencies.writeOutput(APPROVAL_HELP);
    return 0;
  }
  return runApprovalCommand(
    args,
    await healthyCoordinator(dependencies),
    dependencies,
    { localOperator: true },
  );
}
