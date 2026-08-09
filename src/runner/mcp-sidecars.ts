import type { EffectiveConfig } from "../config.ts";
import type { ContainerBackend, McpSidecarSpec } from "../container.ts";
import type { Logger } from "../logging.ts";
import type { McpCatalog, McpRuntime } from "../mcp.ts";
import { IntegralError } from "../errors.ts";

export class McpSidecarManager {
  private readonly sessions = new Map<string, Map<string, McpRuntime>>();

  constructor(
    private readonly containers: ContainerBackend,
    private readonly config: EffectiveConfig,
    private readonly network: string,
    private readonly logger: Logger,
    private readonly writeExtension: (
      sessionHome: string,
      catalogs: McpCatalog[],
    ) => Promise<void>,
  ) {}

  async start(
    spec: { home: string; args: string[]; sessionId: string },
    catalogs: McpCatalog[],
    sidecars: McpSidecarSpec[],
  ): Promise<void> {
    const runtimes = new Map<string, McpRuntime>(),
      unavailable: string[] = [],
      diagnostics: string[] = [];
    for (const sidecar of sidecars) {
      if (!this.containers.createMcpSidecar) {
        unavailable.push(
          `${sidecar.connection.name} (stdio MCP is unavailable)`,
        );
        continue;
      }
      const runtime = this.containers.createMcpSidecar(
        sidecar,
        this.config,
        this.network,
        (line) =>
          this.logger.event("debug", "mcp.stderr", line, {
            connection: sidecar.connection.name,
            session_id: spec.sessionId,
          }),
      );
      try {
        const catalog = await runtime.start();
        catalogs.push(catalog);
        diagnostics.push(
          ...(catalog.diagnostics ?? []).map(
            (diagnostic) => `${sidecar.connection.name}: ${diagnostic}`,
          ),
        );
        runtimes.set(sidecar.connection.name, runtime);
      } catch (error) {
        await runtime.stop().catch(() => undefined);
        unavailable.push(
          `${sidecar.connection.name} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    if (runtimes.size) this.sessions.set(spec.sessionId, runtimes);
    await this.writeExtension(spec.home, catalogs);
    if (unavailable.length)
      spec.args.push(
        "--append-system-prompt",
        `Unavailable MCP connections: ${unavailable.join(", ")}.`,
      );
    if (diagnostics.length)
      spec.args.push(
        "--append-system-prompt",
        `Excluded MCP tools: ${diagnostics.join(", ")}.`,
      );
  }

  async stop(sessionId: string): Promise<void> {
    const runtimes = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (runtimes)
      await Promise.all(
        [...runtimes.values()].map((runtime) =>
          runtime.stop().catch(() => undefined),
        ),
      );
  }

  async callTool(
    sessionId: string,
    connection: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const runtime = this.sessions.get(sessionId)?.get(connection);
    if (!runtime) throw new IntegralError("MCP sidecar not found", 404);
    return await runtime.callTool(tool, args);
  }
}
