import { IntegralError } from "../errors.ts";
import { componentEndpoint, verifiedFetch } from "../http-client.ts";
import type { IntegralPaths } from "../paths.ts";
import { resolvePaths } from "../paths.ts";
import { fetchJson, requestOk } from "./http.ts";

const HELP = `Usage: integral queue <command>

Commands:
  ls [--json]             list queued and in-flight messages
  edit <id> <text>        edit a queued message
  delete <id>             delete a queued message
`;

interface QueueItem {
  id: string;
  text: string;
  status: string;
}

export interface QueueDependencies {
  resolvePaths(): IntegralPaths;
  componentEndpoint: typeof componentEndpoint;
  verifiedFetch: typeof verifiedFetch;
  fetch: typeof globalThis.fetch;
  writeOutput(text: string): void;
}

const productionDependencies: QueueDependencies = {
  resolvePaths,
  componentEndpoint,
  verifiedFetch,
  fetch: globalThis.fetch,
  writeOutput: (text) => process.stdout.write(text),
};

export async function queueCommand(
  args: string[],
  overrides: Partial<QueueDependencies> = {},
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
  const command = args[0];
  if (command === "ls") {
    const snapshot = (await fetchJson(
      new URL("/integral/snapshot", endpoint),
      dependencies.fetch,
    )) as { queue: QueueItem[] };
    if (args.includes("--json"))
      dependencies.writeOutput(`${JSON.stringify(snapshot.queue, null, 2)}\n`);
    else
      for (const item of snapshot.queue)
        dependencies.writeOutput(`${item.status}\t${item.id}\t${item.text}\n`);
    return 0;
  }
  if (command === "edit") {
    const id = args[1],
      text = args.slice(2).join(" ").trim();
    if (!id || !text)
      throw new IntegralError("usage: integral queue edit <id> <text>");
    await requestOk(
      new URL(`/integral/queue/${id}`, endpoint),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      },
      dependencies.fetch,
    );
    dependencies.writeOutput(`Edited ${id}.\n`);
    return 0;
  }
  if (command === "delete") {
    const id = args[1];
    if (!id) throw new IntegralError("usage: integral queue delete <id>");
    await requestOk(
      new URL(`/integral/queue/${id}`, endpoint),
      { method: "DELETE" },
      dependencies.fetch,
    );
    dependencies.writeOutput(`Deleted ${id}.\n`);
    return 0;
  }
  throw new IntegralError(`unknown queue command: ${command}`);
}
