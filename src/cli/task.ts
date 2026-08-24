import { IntegralError } from "../errors.ts";
import { componentEndpoint, verifiedFetch } from "../http-client.ts";
import type { IntegralPaths } from "../paths.ts";
import { resolvePaths } from "../paths.ts";
import type { ScheduledTask } from "../task-queue.ts";
import { fetchJson, requestJson } from "./http.ts";

const HELP = `Usage: integral task <command>

Commands:
  ls [--json]             list durable task executions
  show <id> [--json]      show one task execution
  cancel <id> [--json]    cancel an active task execution
`;

export interface TaskOperationDependencies {
  fetch: typeof globalThis.fetch;
  writeOutput(text: string): void;
}

export interface TaskDependencies extends TaskOperationDependencies {
  resolvePaths(): IntegralPaths;
  componentEndpoint: typeof componentEndpoint;
  verifiedFetch: typeof verifiedFetch;
}

const productionDependencies: TaskDependencies = {
  resolvePaths,
  componentEndpoint,
  verifiedFetch,
  fetch: globalThis.fetch,
  writeOutput: (text) => process.stdout.write(text),
};

function renderTask(
  task: ScheduledTask,
  detailed: boolean,
  write: (text: string) => void,
): void {
  if (!detailed) {
    write(
      `${task.state}\t${task.executionId}\t${task.scheduledFor}\t${task.prompt}\n`,
    );
    return;
  }
  for (const [key, value] of Object.entries(task))
    write(
      `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}\n`,
    );
}

export async function runTaskCommand(
  args: string[],
  endpoint: string,
  dependencies: TaskOperationDependencies,
): Promise<number> {
  const command = args[0] ?? "ls",
    json = args.includes("--json");
  if (command === "ls") {
    const snapshot = (await fetchJson(
        new URL("/integral/snapshot", endpoint),
        dependencies.fetch,
      )) as { tasks: ScheduledTask[] },
      tasks = snapshot.tasks;
    if (json) dependencies.writeOutput(`${JSON.stringify(tasks, null, 2)}\n`);
    else if (!tasks.length) dependencies.writeOutput("No tasks.\n");
    else
      for (const task of tasks)
        renderTask(task, false, (text) => dependencies.writeOutput(text));
    return 0;
  }
  if (command === "show") {
    const id = args[1];
    if (!id) throw new IntegralError("usage: integral task show <id>");
    const snapshot = (await fetchJson(
        new URL("/integral/snapshot", endpoint),
        dependencies.fetch,
      )) as { tasks: ScheduledTask[] },
      task = snapshot.tasks.find((candidate) => candidate.executionId === id);
    if (!task) throw new IntegralError(`task not found: ${id}`, 404);
    if (json) dependencies.writeOutput(`${JSON.stringify(task, null, 2)}\n`);
    else renderTask(task, true, (text) => dependencies.writeOutput(text));
    return 0;
  }
  if (command === "cancel") {
    const id = args[1];
    if (!id) throw new IntegralError("usage: integral task cancel <id>");
    const task = (await requestJson(
      new URL(`/integral/tasks/${encodeURIComponent(id)}/cancel`, endpoint),
      { method: "POST", body: "{}" },
      dependencies.fetch,
    )) as ScheduledTask;
    if (json) dependencies.writeOutput(`${JSON.stringify(task, null, 2)}\n`);
    else renderTask(task, true, (text) => dependencies.writeOutput(text));
    return 0;
  }
  throw new IntegralError(`unknown task command: ${command}`);
}

export async function taskCommand(
  args: string[],
  overrides: Partial<TaskDependencies> = {},
): Promise<number> {
  const dependencies = { ...productionDependencies, ...overrides };
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    dependencies.writeOutput(HELP);
    return 0;
  }
  const paths = dependencies.resolvePaths();
  let endpoint: string;
  try {
    endpoint = await dependencies.componentEndpoint(paths, "coordinator");
    await dependencies.verifiedFetch(paths, "coordinator", "/integral/health");
  } catch {
    throw new IntegralError(
      "coordinator is not reachable; start it with integral server start",
    );
  }
  return runTaskCommand(args, endpoint, dependencies);
}
