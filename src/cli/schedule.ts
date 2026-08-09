import { IntegralError } from "../errors.ts";
import { componentEndpoint, verifiedFetch } from "../http-client.ts";
import type { ModelSelection } from "../model-selection.ts";
import type { IntegralPaths } from "../paths.ts";
import { resolvePaths } from "../paths.ts";
import { fetchJson, requestJson } from "./http.ts";

const HELP = `Usage: integral schedule <command>

Commands:
  ls [--json]                              list active schedules
  show <id> [--json]                       show one schedule
  history <id> [--json]                    show definition revisions
  runs [<id>] [--json]                     show occurrence and attempt history
  create --prompt <text> (--cron <expr> --timezone <zone> | --at <instant>)
  update <id> --revision <n> [trigger and prompt options]
  enable|disable|delete <id> --revision <n>
  restore <id> <commit> --revision <n>      restore as a new revision
  cancel <execution-id>                    cancel an active one-time task
`;

export interface ScheduleDependencies {
  resolvePaths(): IntegralPaths;
  componentEndpoint: typeof componentEndpoint;
  verifiedFetch: typeof verifiedFetch;
  fetch: typeof globalThis.fetch;
  writeOutput(text: string): void;
}

const productionDependencies: ScheduleDependencies = {
  resolvePaths,
  componentEndpoint,
  verifiedFetch,
  fetch: globalThis.fetch,
  writeOutput: (text) => process.stdout.write(text),
};

export async function scheduleCommand(
  args: string[],
  overrides: Partial<ScheduleDependencies> = {},
): Promise<number> {
  const dependencies = { ...productionDependencies, ...overrides };
  if (
    !args[0] ||
    args.includes("--help") ||
    args.includes("-h") ||
    args[0] === "help"
  ) {
    dependencies.writeOutput(HELP);
    return 0;
  }
  const paths = dependencies.resolvePaths(),
    scheduler = await dependencies.componentEndpoint(paths, "scheduler");
  await dependencies
    .verifiedFetch(paths, "scheduler", "/integral/health")
    .catch(() => {
      throw new IntegralError(
        "scheduler is not reachable; start it with integral server start",
      );
    });
  const command = args[0],
    jsonOutput = args.includes("--json");
  if (command === "ls") {
    const value = await fetchJson(
      new URL("/integral/schedules", scheduler),
      dependencies.fetch,
    );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  if (command === "show" || command === "history") {
    const id = args[1];
    if (!id)
      throw new IntegralError(`usage: integral schedule ${command} <id>`);
    const suffix = command === "history" ? "/history" : "",
      value = await fetchJson(
        new URL(
          `/integral/schedules/${encodeURIComponent(id)}${suffix}`,
          scheduler,
        ),
        dependencies.fetch,
      );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  if (command === "runs") {
    const url = new URL("/integral/occurrences", scheduler),
      scheduleId = args[1];
    if (scheduleId && !scheduleId.startsWith("--"))
      url.searchParams.set("scheduleId", scheduleId);
    const value = await fetchJson(url, dependencies.fetch);
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  if (command === "cancel") {
    const executionId = args[1];
    if (!executionId)
      throw new IntegralError("usage: integral schedule cancel <execution-id>");
    const coordinator = await dependencies.componentEndpoint(
        paths,
        "coordinator",
      ),
      value = await requestJson(
        new URL(
          `/integral/tasks/${encodeURIComponent(executionId)}/cancel`,
          coordinator,
        ),
        { method: "POST", body: "{}" },
        dependencies.fetch,
      );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  const actor = "operator";
  if (command === "create") {
    const prompt = flag(args, "--prompt");
    if (!prompt)
      throw new IntegralError("schedule create requires --prompt <text>");
    const coordinator = await dependencies.componentEndpoint(
        paths,
        "coordinator",
      ),
      snapshot = (await fetchJson(
        new URL("/integral/snapshot", coordinator),
        dependencies.fetch,
      )) as { modelSelection?: ModelSelection | null };
    if (!snapshot.modelSelection)
      throw new IntegralError("select a model before creating a schedule");
    const value = await requestJson(
      new URL("/integral/schedules", scheduler),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor,
          prompt,
          trigger: scheduleTriggerFromFlags(args),
          profile: snapshot.modelSelection,
        }),
      },
      dependencies.fetch,
    );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  if (["update", "enable", "disable", "delete", "restore"].includes(command)) {
    const id = args[1],
      revision = Number(flag(args, "--revision"));
    if (!id || !Number.isInteger(revision) || revision < 1)
      throw new IntegralError(
        `integral schedule ${command} requires <id> --revision <n>`,
      );
    let path = `/integral/schedules/${encodeURIComponent(id)}`,
      method = "POST";
    const body: Record<string, unknown> = { actor, expectedRevision: revision };
    if (command === "update") {
      method = "PATCH";
      const prompt = flag(args, "--prompt");
      if (prompt) body.prompt = prompt;
      if (flag(args, "--at") || flag(args, "--cron"))
        body.trigger = scheduleTriggerFromFlags(args);
    } else if (command === "delete") method = "DELETE";
    else {
      path += `/${command}`;
      if (command === "restore") {
        const commit = args[2];
        if (!commit)
          throw new IntegralError(
            "usage: integral schedule restore <id> <commit> --revision <n>",
          );
        body.commit = commit;
      }
    }
    const value = await requestJson(
      new URL(path, scheduler),
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      dependencies.fetch,
    );
    renderScheduleValue(value, jsonOutput, dependencies.writeOutput);
    return 0;
  }
  throw new IntegralError(`unknown schedule command: ${command}`);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function scheduleTriggerFromFlags(args: string[]): Record<string, string> {
  const runAt = flag(args, "--at"),
    cron = flag(args, "--cron"),
    timezone = flag(args, "--timezone");
  if (runAt && !cron && !timezone) return { type: "once", runAt };
  if (!runAt && cron && timezone) return { type: "recurring", cron, timezone };
  throw new IntegralError(
    "provide either --at <instant> or both --cron <expression> and --timezone <zone>",
  );
}

function renderScheduleValue(
  value: unknown,
  jsonOutput: boolean,
  write: (text: string) => void,
): void {
  if (jsonOutput) {
    write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      write(`${String(row)}\n`);
      continue;
    }
    const item = row as Record<string, unknown>;
    write(
      [
        item.state ??
          (item.deleted
            ? "deleted"
            : item.enabled === false
              ? "disabled"
              : "enabled"),
        item.id ?? item.scheduleId ?? item.executionId ?? item.commit,
        item.revision ?? item.scheduledFor ?? item.operation ?? "",
        item.prompt ?? item.error ?? "",
      ]
        .filter((part) => part !== undefined && part !== "")
        .join("\t") + "\n",
    );
  }
}
