# Logging behaviors

These behaviors define diagnostic logging for CLI commands and the coordinator,
runner, and gateway in combined or separate-process operation.

## LOG-0A6F3D92 — Configure component logging

Given `[logging]` may define `level` and `format`
	When an rr process starts
		Then `level` accepts only `error`, `warn`, `info`, `debug`, or `trace`
			And defaults to `info`
			And `format` accepts only `text` or `json`
			And defaults to `text`
			And `RR_LOG_LEVEL` and `RR_LOG_FORMAT` override file values

## LOG-4A81D2C7 — Keep command results separate from diagnostics

Given an rr CLI command produces a result and diagnostic logs
	When it writes process output
		Then command results are written to stdout
			And diagnostic logs are written to stderr
			And JSON command output remains parseable without filtering logs

## LOG-B7E30A19 — Emit one structured JSON event per line

Given effective log format is `json`
	When rr emits a log event
		Then it writes one complete JSON object on one stderr line
			And includes `timestamp`, `level`, `component`, `event`, and `message`
			And uses a UTC RFC 3339 timestamp
			And emits no ANSI escape sequences

## LOG-2C96F4E8 — Emit readable text logs

Given effective log format is `text`
	When rr emits a log event
		Then it includes timestamp, level, component, event, and message
			And escapes embedded newlines so each event occupies one diagnostic line
			And respects `NO_COLOR`

## LOG-D18A73C5 — Filter events by level

Given an effective log level is configured
	When rr considers a diagnostic event
		Then it emits events at that level or a more severe level
			And suppresses less severe events
			And applies the same ordering `error`, `warn`, `info`, `debug`, `trace` in every component

## LOG-6F20B9A4 — Use stable event names

Given rr emits a diagnostic event
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

## LOG-A42D8F16 — Identify deployment and process context

Given an rr component emits a log event
	When it renders structured context
		Then it identifies its component and process ID
			And identifies the deployment with a non-secret stable deployment ID
			And does not log the absolute `RR_HOME` path by default

## LOG-7B31C9E0 — Log component lifecycle transitions

Given a server component starts, becomes ready, becomes degraded, recovers, or stops
	When its lifecycle state changes
		Then it emits an event naming the old and new state
			And includes its bound address without embedded credentials
			And combined mode emits distinct lifecycle events for each component

## LOG-E5A81D23 — Log aggregate startup failure

Given combined server startup fails
	When rr stops partially started components
		Then it logs the original failure at `error`
			And logs cleanup outcomes for every component it attempted to stop
			And does not replace the original cause with a cleanup error

## LOG-18C7F2A9 — Log gateway decisions without request secrets

Given the gateway allows or denies a request
	When it emits the decision event
		Then it includes verdict, method, normalized host, port, session ID, and request ID
			And includes the matched connection name when one exists
			And omits authorization values, cookies, query strings, and request and response bodies
			And identifies policy denial separately from upstream failure

## LOG-C4E29B71 — Keep conversation content out of diagnostic logs

Given the coordinator enqueues, edits, deletes, claims, or completes a message
	When it emits a queue or conversation event
		Then it logs the message ID and state transition
			And does not log user message text or assistant response text
			And preserves this rule at `debug` and `trace` levels

## LOG-5D80A3F6 — Handle Pi protocol output separately

Given Pi emits RPC protocol events on stdout or diagnostics on stderr
	When the runner consumes that output
		Then it parses stdout as protocol data rather than component log lines
			And does not forward raw protocol JSON to attached terminals
			And records Pi stderr as runner diagnostics with session correlation
			And removes conversation content from captured Pi diagnostics
			And applies rr redaction before emitting captured Pi diagnostics

## LOG-F19C62A8 — Redact secrets in every format and level

Given a value is a connection credential, authorization header, cookie, OAuth code, refresh token, proxy session token, or component identity
	When rr would emit that value in text or JSON logs
		Then rr replaces it with a redaction marker
			And applies redaction before serialization
			And applies the same redaction at `trace` level
			And never treats logging configuration as permission to reveal it

## LOG-81A4E7D3 — Avoid persistent log files by default

Given no external process captures stderr
	When rr emits diagnostic logs
		Then rr does not create a durable log file under `RR_HOME`
			And leaves persistence and rotation to the invoking terminal or service manager

## LOG-3E72B5C1 — Report configuration errors before component logging starts

Given logging configuration is invalid
	When an rr process starts
		Then it writes a minimal plain-text error to stderr
			And identifies the invalid logging option
			And exits non-zero without starting a component

## LOG-AD90C4E2 — Preserve logging behavior across deployment modes

Given the same effective logging configuration
	When components run together in one process or separately in three processes
		Then each component emits the same event fields and level decisions
			And combined mode does not merge distinct component events into one event
			And separate mode does not require different parsing rules
