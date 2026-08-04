# Logging behaviors

These behaviors define diagnostic logging for CLI commands and the coordinator,
runner, gateway, and scheduler in combined or separate-process operation.

## LOG-0A6F3D92 — Configure component logging

Given `[logging]` may define `level` and `format`
	When an integral process starts
		Then `level` accepts only `error`, `warn`, `info`, `debug`, or `trace`
			And defaults to `info`
			And `format` accepts only `text` or `json`
			And defaults to `text`
			And `INTEGRAL_LOG_LEVEL` and `INTEGRAL_LOG_FORMAT` override file values

## LOG-4A81D2C7 — Keep command results separate from diagnostics

Given an integral CLI command produces a result and diagnostic logs
	When it writes process output
		Then command results are written to stdout
			And diagnostic logs are written to stderr
			And JSON command output remains parseable without filtering logs

## LOG-B7E30A19 — Emit one structured JSON event per line

Given effective log format is `json`
	When integral emits a log event
		Then it writes one complete JSON object on one stderr line
			And includes `timestamp`, `level`, `component`, `event`, and `message`
			And uses a UTC RFC 3339 timestamp
			And emits no ANSI escape sequences

## LOG-2C96F4E8 — Emit readable text logs

Given effective log format is `text`
	When integral emits a log event
		Then it includes timestamp, level, component, event, and message
			And escapes embedded newlines so each event occupies one diagnostic line
			And respects `NO_COLOR`

## LOG-D18A73C5 — Filter events by level

Given an effective log level is configured
	When integral considers a diagnostic event
		Then it emits events at that level or a more severe level
			And suppresses less severe events
			And applies the same ordering `error`, `warn`, `info`, `debug`, `trace` in every component

## LOG-6F20B9A4 — Use stable event names

Given integral emits a diagnostic event
	When it identifies the event type
		Then it uses a stable machine-readable event name
			And does not derive the event name from prose
			And preserves event names across text and JSON formats

## LOG-93C1E6B7 — Correlate work across components

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

## LOG-A42D8F16 — Identify deployment and process context

Given an integral component emits a log event
	When it renders structured context
		Then it identifies its component and process ID
			And identifies the deployment with a non-secret stable deployment ID
			And does not log the absolute `INTEGRAL_HOME` path by default

## LOG-7B31C9E0 — Log component startup and shutdown transitions

Given a server component starts, becomes ready, fails during startup, or stops cleanly
	When its lifecycle state changes
		Then it emits an event naming the old and new state
			And a ready event includes its bound address without embedded credentials
			And a startup failure is emitted at `error`
			And combined mode emits distinct lifecycle events for each component

## LOG-28BE37DE — Explain model catalog refresh progress

Given the coordinator refreshes the model catalog during or after startup
	When it resolves the Pi runtime, resolves the managed image, or discovers models
		Then it emits an informational progress event naming the active stage
			And reports catalog readiness with the discovered model count
	When catalog refresh fails
		Then it emits a warning with the failure reason
			And does not expose model credentials

## LOG-E5A81D23 — Log aggregate startup failure

Given combined server startup fails
	When integral stops partially started components
		Then it logs the failing component's startup error at `error`
			And logs successful component stops as lifecycle events
			And logs stop or unlock failures as `component.cleanup_failed`
			And does not replace the original cause with a cleanup error

## LOG-18C7F2A9 — Log gateway decisions without request secrets

Given the gateway allows or denies a request
	When it emits the decision event
		Then it includes verdict, method, normalized host, port, session ID, and request ID
			And includes the matched connection name when one exists
			And omits authorization values, cookies, query strings, and request and response bodies
			And identifies policy denial separately from upstream failure

## LOG-C4E29B71 — Keep conversation content out of component diagnostics

Given the runner or gateway emits a diagnostic related to a message or session
	When it writes structured context
		Then it may include applicable message, session, request, and connection identifiers
			And does not add user message text or assistant response text to that context
			And preserves this rule at `debug` and `trace` levels
Given the coordinator publishes queue and conversation events to attached terminals
	When those events contain conversation text
		Then it does not also write them through the component diagnostic logger

## LOG-5D80A3F6 — Handle Pi protocol output separately

Given Pi emits RPC protocol events on stdout or diagnostics on stderr
	When the runner consumes that output
		Then it parses stdout as protocol data rather than component log lines
			And does not forward raw protocol JSON to attached terminals
			And records Pi stderr at `debug` as runner diagnostics with session correlation
			And escapes embedded newlines in captured Pi diagnostics
			And applies integral redaction before emitting captured Pi diagnostics

## LOG-F19C62A8 — Redact secrets in every format and level

Given a value is supplied to the component logger as a known credential
	Or appears under a credential-bearing key such as authorization, cookie, secret, token, password, or API key
	When integral would emit that value in text or JSON logs
		Then integral replaces it with a redaction marker
			And recognizes inline Basic and Bearer authorization values
			And applies redaction before serialization
			And applies the same redaction at `trace` level
			And never treats logging configuration as permission to reveal it

## LOG-81A4E7D3 — Avoid persistent log files by default

Given no external process captures stderr
	When integral emits diagnostic logs
		Then integral does not create a durable log file under `INTEGRAL_HOME`
			And leaves persistence and rotation to the invoking terminal or service manager

## LOG-3E72B5C1 — Report configuration errors before component logging starts

Given logging configuration is invalid
	When an integral process starts
		Then it writes a minimal plain-text error to stderr
			And identifies the invalid logging option
			And exits non-zero without starting a component

## LOG-AD90C4E2 — Preserve logging behavior across deployment modes

Given the same effective logging configuration
	When components run together in one process or separately in four processes
		Then each component emits the same event fields and level decisions
			And combined mode does not merge distinct component events into one event
			And separate mode does not require different parsing rules
