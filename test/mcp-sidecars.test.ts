import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import type { ContainerBackend, McpSidecarSpec } from "../src/container.ts";
import { validateConnection } from "../src/connections.ts";
import { Logger } from "../src/logging.ts";
import type { McpRuntime } from "../src/mcp.ts";
import { McpSidecarManager } from "../src/runner/mcp-sidecars.ts";
import { fixture } from "./helpers.ts";

test("[MCP-0A804DA4] sidecar supervision isolates startup and invocation failures and releases every runtime", async (t) => {
  const paths = await fixture(t),
    config = await loadConfig(paths, {}),
    stopped: string[] = [],
    health: Array<[string, boolean]> = [],
    extensions: string[][] = [],
    sidecar = (name: string): McpSidecarSpec => ({
      connection: validateConnection({
        name,
        kind: "mcp",
        auth: "none",
        transport: "stdio",
        command: "server",
      }),
      image: "image",
      sessionId: "session",
      sessionToken: "token",
      gatewayUrl: "http://gateway",
      gatewayAddress: "172.18.0.1",
      caCert: "/ca",
      caBundle: "/bundle",
      secretValues: {},
    }),
    backend = {
      createMcpSidecar(spec: McpSidecarSpec): McpRuntime {
        return {
          connection: spec.connection,
          async start() {
            if (spec.connection.name === "broken")
              throw new Error("invalid protocol output");
            return {
              connection: spec.connection,
              protocolVersion: "2025-11-25",
              tools: [{ name: "run", inputSchema: { type: "object" } }],
            };
          },
          async callTool(name) {
            if (name === "hang") throw new Error("bounded sidecar timeout");
            return { content: [{ type: "text", text: "ok" }] };
          },
          async stop() {
            stopped.push(spec.connection.name);
          },
        };
      },
    } as unknown as ContainerBackend,
    manager = new McpSidecarManager(
      backend,
      config,
      "network",
      new Logger({
        component: "runner",
        deploymentId: "test",
        level: "error",
        format: "json",
        sink: () => undefined,
      }),
      async (_home, catalogs) => {
        extensions.push(catalogs.map((catalog) => catalog.connection.name));
      },
      async (name, healthy) => {
        health.push([name, healthy]);
      },
    );
  const args: string[] = [];
  await manager.start(
    { home: paths.root, args, sessionId: "session" },
    [],
    [sidecar("healthy"), sidecar("broken")],
  );
  assert.deepEqual(extensions, [["healthy"]]);
  assert.deepEqual(health, [
    ["healthy", true],
    ["broken", false],
  ]);
  assert.match(args.join(" "), /Unavailable MCP connections: broken/);
  assert.deepEqual(await manager.callTool("session", "healthy", "run", {}), {
    content: [{ type: "text", text: "ok" }],
  });
  await assert.rejects(
    manager.callTool("session", "healthy", "hang", {}),
    /bounded sidecar timeout/,
  );
  await assert.rejects(
    manager.callTool("session", "broken", "run", {}),
    /sidecar not found/,
  );
  await manager.stop("session");
  assert.deepEqual(stopped.sort(), ["broken", "healthy"]);
});
