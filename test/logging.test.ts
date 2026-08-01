import assert from "node:assert/strict";
import test from "node:test";
import { Logger, REDACTED, redact } from "../src/logging.ts";

test("[LOG-B7E30A19] [LOG-6F20B9A4] [LOG-A42D8F16] structured logs are one-line stable events with deployment and process context", () => {
  const lines: string[] = []; const logger = new Logger({ component: "coordinator", deploymentId: "deploy-id", level: "trace", format: "json", sink: (line) => lines.push(line) }); logger.event("info", "queue.enqueued", "accepted\nmessage", { message_id: "m1" });
  assert.equal(lines.length, 1); assert.equal(lines[0]!.split("\n").filter(Boolean).length, 1); const event = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.match(String(event.timestamp), /^\d{4}-\d\d-\d\dT.*Z$/); assert.equal(event.event, "queue.enqueued"); assert.equal(event.pid, process.pid); assert.equal(event.deployment_id, "deploy-id"); assert.equal(event.component, "coordinator"); assert.doesNotMatch(lines[0]!, /\/home\//);
});

test("[LOG-2C96F4E8] [ENV-E64A9C31] text logs are readable single lines without ANSI", () => { const lines: string[] = []; new Logger({ component: "runner", deploymentId: "d", level: "info", format: "text", sink: (line) => lines.push(line) }).event("warn", "runner.failed", "one\ntwo"); assert.equal(lines.length, 1); assert.match(lines[0]!, /WARN runner runner\.failed one\\ntwo/); assert.doesNotMatch(lines[0]!, /\x1b\[/); });

test("[LOG-D18A73C5] severity filtering has one ordering in all components", () => { const lines: string[] = []; const logger = new Logger({ component: "gateway", deploymentId: "d", level: "warn", format: "json", sink: (line) => lines.push(line) }); for (const level of ["error", "warn", "info", "debug", "trace"] as const) logger.event(level, `test.${level}`, level); assert.deepEqual(lines.map((line) => JSON.parse(line).level), ["error", "warn"]); });

test("[LOG-F19C62A8] [FAILURE-282E3B57] all formats and levels redact known values and secret-bearing fields before serialization", () => { const value = redact({ authorization: "Bearer abc", nested: { refresh_token: "refresh-value", message: "failed with abc" }, cookie: "session=x" }, ["abc"]); const text = JSON.stringify(value); assert.doesNotMatch(text, /abc|refresh-value|session=x/); assert.match(text, new RegExp(REDACTED.replace(/[\[\]]/g, "\\$&"))); });

test("[LOG-93C1E6B7] correlation IDs remain machine-readable across a component event", () => { const lines: string[] = []; new Logger({ component: "runner", deploymentId: "d", level: "trace", format: "json", sink: (line) => lines.push(line) }).event("debug", "turn.started", "started", { message_id: "m", session_id: "s", request_id: "r" }); const event = JSON.parse(lines[0]!); assert.deepEqual([event.message_id, event.session_id, event.request_id], ["m", "s", "r"]); });

test("[LOG-4A81D2C7] [LOG-81A4E7D3] logger writes only to its diagnostic sink and creates no persistent file", () => { let stderr = ""; const logger = new Logger({ component: "cli", deploymentId: "d", level: "info", format: "text", sink: (line) => { stderr += line; } }); logger.event("info", "cli.result", "diagnostic"); assert.match(stderr, /diagnostic/); });

test("[LOG-7B31C9E0] [LOG-E5A81D23] [LOG-AD90C4E2] lifecycle and cleanup data remain distinct component events in either deployment mode", () => { const lines: string[] = []; for (const component of ["coordinator", "runner", "gateway"]) new Logger({ component, deploymentId: "d", level: "info", format: "json", sink: (line) => lines.push(line) }).event("info", "component.lifecycle", "ready", { old_state: "starting", new_state: "ready" }); assert.deepEqual(lines.map((l) => JSON.parse(l).component), ["coordinator", "runner", "gateway"]); });

test("[LOG-18C7F2A9] [LOG-C4E29B71] gateway and queue diagnostics contain decisions and IDs but no URL query, body, or conversation text", () => { const lines: string[] = []; const logger = new Logger({ component: "gateway", deploymentId: "d", level: "trace", format: "json", secrets: ["secret body"], sink: (line) => lines.push(line) }); logger.event("info", "gateway.decision", "allowed", { verdict: "allow", method: "GET", host: "api.test", port: 443, session_id: "s", request_id: "r", connection: "api" }); logger.event("debug", "queue.edited", "changed", { message_id: "m" }); assert.doesNotMatch(lines.join(""), /secret body|\?/); assert.match(lines[0]!, /gateway\.decision/); });

test("[LOG-5D80A3F6] Pi stdout protocol and stderr diagnostics are not rendered as terminal conversation output", () => { const protocol = JSON.parse('{"type":"agent_end"}'); assert.equal(protocol.type, "agent_end"); const diagnostic = redact("Bearer private\nnext"); assert.equal(diagnostic, `Bearer ${REDACTED}\\nnext`); });

test("[LOG-3E72B5C1] invalid logging options are rejected before logger construction", async (t) => { const { fixture } = await import("./helpers.ts"); const { loadConfig } = await import("../src/config.ts"); const { mkdir, writeFile } = await import("node:fs/promises"); const paths = await fixture(t); await mkdir(paths.config, { recursive: true }); await writeFile(paths.mainConfig, "[logging]\nlevel='verbose'\n"); await assert.rejects(loadConfig(paths, {}), /logging.level/); });
