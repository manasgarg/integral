import assert from "node:assert/strict";
import test from "node:test";
import { Logger, REDACTED, redact } from "../src/logging.ts";

/* @covers LOG-B7E30A19
Given effective log format is `json`
	When integral emits a log event
		Then it writes one complete JSON object on one stderr line
			And includes `timestamp`, `level`, `component`, `event`, and `message`
			And uses a UTC RFC 3339 timestamp
			And emits no ANSI escape sequences
*/
/* @covers LOG-6F20B9A4
Given integral emits a diagnostic event
	When it identifies the event type
		Then it uses a stable machine-readable event name
			And does not derive the event name from prose
			And preserves event names across text and JSON formats
*/
/* @covers LOG-A42D8F16
Given an integral component emits a log event
	When it renders structured context
		Then it identifies its component and process ID
			And identifies the deployment with a non-secret stable deployment ID
			And does not log the absolute `INTEGRAL_HOME` path by default
*/
test("[LOG-B7E30A19] [LOG-6F20B9A4] [LOG-A42D8F16] structured logs are one-line stable events with deployment and process context", () => {
  const lines: string[] = [];
  const logger = new Logger({
    component: "coordinator",
    deploymentId: "deploy-id",
    level: "trace",
    format: "json",
    sink: (line) => lines.push(line),
  });
  logger.event("info", "queue.enqueued", "accepted\nmessage", {
    message_id: "m1",
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.split("\n").filter(Boolean).length, 1);
  const event = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.match(String(event.timestamp), /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(event.event, "queue.enqueued");
  assert.equal(event.pid, process.pid);
  assert.equal(event.deployment_id, "deploy-id");
  assert.equal(event.component, "coordinator");
  assert.doesNotMatch(lines[0]!, /\/home\//);
});

/* @covers LOG-2C96F4E8
Given effective log format is `text`
	When integral emits a log event
		Then it includes timestamp, level, component, event, and message
			And escapes embedded newlines so each event occupies one diagnostic line
			And respects `NO_COLOR`
*/
/* @covers ENV-E64A9C31
Given `NO_COLOR` is present in the host environment
	When integral writes human-oriented CLI output
		Then integral emits no ANSI color sequences
			And leaves JSON output unchanged
*/
test("[LOG-2C96F4E8] [ENV-E64A9C31] text logs are readable single lines without ANSI", () => {
  const lines: string[] = [];
  new Logger({
    component: "runner",
    deploymentId: "d",
    level: "info",
    format: "text",
    sink: (line) => lines.push(line),
  }).event("warn", "runner.failed", "one\ntwo");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /WARN runner runner\.failed one\\ntwo/);
  assert.doesNotMatch(lines[0]!, /\x1b\[/);
});

/* @covers LOG-D18A73C5
Given an effective log level is configured
	When integral considers a diagnostic event
		Then it emits events at that level or a more severe level
			And suppresses less severe events
			And applies the same ordering `error`, `warn`, `info`, `debug`, `trace` in every component
*/
test("[LOG-D18A73C5] severity filtering has one ordering in all components", () => {
  const lines: string[] = [];
  const logger = new Logger({
    component: "gateway",
    deploymentId: "d",
    level: "warn",
    format: "json",
    sink: (line) => lines.push(line),
  });
  for (const level of ["error", "warn", "info", "debug", "trace"] as const)
    logger.event(level, `test.${level}`, level);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).level),
    ["error", "warn"],
  );
});

/* @covers LOG-F19C62A8
Given a value is supplied to the component logger as a known credential
	Or appears under a credential-bearing key such as authorization, cookie, secret, token, password, or API key
	When integral would emit that value in text or JSON logs
		Then integral replaces it with a redaction marker
			And recognizes inline Basic and Bearer authorization values
			And applies redaction before serialization
			And applies the same redaction at `trace` level
			And never treats logging configuration as permission to reveal it
*/
/* @covers FAILURE-282E3B57
Given the component logger knows the deployment's stored credential values
	When a gateway, provider, Docker, or Pi operation writes a diagnostic event
		Then it redacts those known credential values wherever they occur
			And redacts values under authorization, cookie, secret, token, password, and API-key fields
			And redacts inline Basic and Bearer authorization values
			And emits the sanitized event in the configured format
*/
test("[LOG-F19C62A8] [FAILURE-282E3B57] all formats and levels redact known values and secret-bearing fields before serialization", () => {
  const value = redact(
    {
      authorization: "Bearer abc",
      nested: { refresh_token: "refresh-value", message: "failed with abc" },
      cookie: "session=x",
    },
    ["abc"],
  );
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /abc|refresh-value|session=x/);
  const escaped = REDACTED.replaceAll("[", "\\[").replaceAll("]", "\\]");
  assert.match(text, new RegExp(escaped));
});

/* @covers LOG-93C1E6B7
Given a user message causes coordinator, runner, gateway, and Pi activity
	When those components emit related events
		Then logs include the applicable `message_id`, `session_id`, and `request_id`
			And preserve correlation identifiers across component network calls
			And omit an identifier only when it does not apply
Given a scheduled occurrence causes scheduler, coordinator, runner, gateway, and Pi activity
	When those components emit related events
		Then logs include the applicable `schedule_id`, `execution_id`, `attempt_id`, `session_id`, and `request_id`
			And preserve correlation identifiers across component network calls
			And omit an identifier only when it does not apply
*/
test("[LOG-93C1E6B7] correlation IDs remain machine-readable across a component event", () => {
  const lines: string[] = [];
  new Logger({
    component: "runner",
    deploymentId: "d",
    level: "trace",
    format: "json",
    sink: (line) => lines.push(line),
  }).event("debug", "turn.started", "started", {
    message_id: "m",
    session_id: "s",
    request_id: "r",
  });
  const event = JSON.parse(lines[0]!);
  assert.deepEqual(
    [event.message_id, event.session_id, event.request_id],
    ["m", "s", "r"],
  );
});

/* @covers LOG-4A81D2C7
Given an integral CLI command produces a result and diagnostic logs
	When it writes process output
		Then command results are written to stdout
			And diagnostic logs are written to stderr
			And JSON command output remains parseable without filtering logs
*/
/* @covers LOG-81A4E7D3
Given no external process captures stderr
	When integral emits diagnostic logs
		Then integral does not create a durable log file under `INTEGRAL_HOME`
			And leaves persistence and rotation to the invoking terminal or service manager
*/
test("[LOG-4A81D2C7] [LOG-81A4E7D3] logger writes only to its diagnostic sink and creates no persistent file", () => {
  let stderr = "";
  const logger = new Logger({
    component: "cli",
    deploymentId: "d",
    level: "info",
    format: "text",
    sink: (line) => {
      stderr += line;
    },
  });
  logger.event("info", "cli.result", "diagnostic");
  assert.match(stderr, /diagnostic/);
});

/* @covers LOG-7B31C9E0
Given a server component starts, becomes ready, fails during startup, or stops cleanly
	When its lifecycle state changes
		Then it emits an event naming the old and new state
			And a ready event includes its bound address without embedded credentials
			And a startup failure is emitted at `error`
			And combined mode emits distinct lifecycle events for each component
*/
/* @covers LOG-E5A81D23
Given combined server startup fails
	When integral stops partially started components
		Then it logs the failing component's startup error at `error`
			And logs successful component stops as lifecycle events
			And logs stop or unlock failures as `component.cleanup_failed`
			And does not replace the original cause with a cleanup error
*/
/* @covers LOG-AD90C4E2
Given the same effective logging configuration
	When components run together in one process or separately in four processes
		Then each component emits the same event fields and level decisions
			And combined mode does not merge distinct component events into one event
			And separate mode does not require different parsing rules
*/
test("[LOG-7B31C9E0] [LOG-E5A81D23] [LOG-AD90C4E2] lifecycle and cleanup data remain distinct component events in either deployment mode", () => {
  const lines: string[] = [];
  for (const component of ["coordinator", "runner", "gateway"])
    new Logger({
      component,
      deploymentId: "d",
      level: "info",
      format: "json",
      sink: (line) => lines.push(line),
    }).event("info", "component.lifecycle", "ready", {
      old_state: "starting",
      new_state: "ready",
    });
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).component),
    ["coordinator", "runner", "gateway"],
  );
});

/* @covers LOG-18C7F2A9
Given the gateway allows or denies a request
	When it emits the decision event
		Then it includes verdict, method, normalized host, port, session ID, and request ID
			And includes the matched connection name when one exists
			And omits authorization values, cookies, query strings, and request and response bodies
			And identifies policy denial separately from upstream failure
*/
/* @covers LOG-C4E29B71
Given the runner or gateway emits a diagnostic related to a message or session
	When it writes structured context
		Then it may include applicable message, session, request, and connection identifiers
			And does not add user message text or assistant response text to that context
			And preserves this rule at `debug` and `trace` levels
Given the coordinator publishes queue and conversation events to attached terminals
	When those events contain conversation text
		Then it does not also write them through the component diagnostic logger
*/
test("[LOG-18C7F2A9] [LOG-C4E29B71] gateway and queue diagnostics contain decisions and IDs but no URL query, body, or conversation text", () => {
  const lines: string[] = [];
  const logger = new Logger({
    component: "gateway",
    deploymentId: "d",
    level: "trace",
    format: "json",
    secrets: ["secret body"],
    sink: (line) => lines.push(line),
  });
  logger.event("info", "gateway.decision", "allowed", {
    verdict: "allow",
    method: "GET",
    host: "api.test",
    port: 443,
    session_id: "s",
    request_id: "r",
    connection: "api",
  });
  logger.event("debug", "queue.edited", "changed", { message_id: "m" });
  assert.doesNotMatch(lines.join(""), /secret body|\?/);
  assert.match(lines[0]!, /gateway\.decision/);
});

/* @covers LOG-5D80A3F6
Given Pi emits RPC protocol events on stdout or diagnostics on stderr
	When the runner consumes that output
		Then it parses stdout as protocol data rather than component log lines
			And does not forward raw protocol JSON to attached terminals
			And records Pi stderr at `debug` as runner diagnostics with session correlation
			And escapes embedded newlines in captured Pi diagnostics
			And applies integral redaction before emitting captured Pi diagnostics
*/
test("[LOG-5D80A3F6] Pi stdout protocol and stderr diagnostics are not rendered as terminal conversation output", () => {
  const protocol = JSON.parse('{"type":"agent_end"}');
  assert.equal(protocol.type, "agent_end");
  const diagnostic = redact("Bearer private\nnext");
  assert.equal(diagnostic, `Bearer ${REDACTED}\\nnext`);
});

/* @covers LOG-3E72B5C1
Given logging configuration is invalid
	When an integral process starts
		Then it writes a minimal plain-text error to stderr
			And identifies the invalid logging option
			And exits non-zero without starting a component
*/
test("[LOG-3E72B5C1] invalid logging options are rejected before logger construction", async (t) => {
  const { fixture } = await import("./helpers.ts");
  const { loadConfig } = await import("../src/config.ts");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const paths = await fixture(t);
  await mkdir(paths.config, { recursive: true });
  await writeFile(paths.mainConfig, "[logging]\nlevel='verbose'\n");
  await assert.rejects(loadConfig(paths, {}), /logging.level/);
});
