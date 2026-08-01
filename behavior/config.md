# Configuration behaviors

These behaviors define integral's strict TOML configuration files, supported Phase 1
options, precedence, validation, and component consistency.

## CONFIG-8A31F6C2 — Locate the main configuration file

Given integral has resolved an `INTEGRAL_HOME`
	When an integral command loads main configuration
		Then it reads `<INTEGRAL_HOME>/config/integral.toml`
			And does not search the current directory or parent directories
			And does not read another deployment's configuration

## CONFIG-2D7C49E1 — Run with built-in defaults when the main file is absent

Given `<INTEGRAL_HOME>/config/integral.toml` does not exist
	When an integral command loads main configuration
		Then loading succeeds with built-in defaults
			And integral does not create the file as a side effect of reading configuration

## CONFIG-C41E8B75 — Initialize a starter configuration

Given the main configuration file does not exist
	When the user runs `integral config init`
		Then integral creates `<INTEGRAL_HOME>/config/integral.toml`
			And creates missing parent directories
			And writes valid TOML containing documented defaults and comments
			And does not write credentials or machine-specific session state
	When the file already exists
		Then `integral config init` refuses to overwrite it
			And leaves its bytes unchanged

## CONFIG-5F20A9D3 — Show config command help

Given integral is installed
	When the user runs `integral config --help`
		Then the command lists `init`, `path`, `show`, and `validate`
			And describes `show` as effective configuration after overrides

## CONFIG-17D6C8A4 — Print the main configuration path

Given integral has resolved an `INTEGRAL_HOME`
	When the user runs `integral config path`
		Then integral prints the absolute path to `<INTEGRAL_HOME>/config/integral.toml`
			And does not require that file to exist

## CONFIG-B93A4E70 — Validate configuration without side effects

Given configuration files may be valid or invalid
	When the user runs `integral config validate`
		Then integral parses and validates the same effective configuration used by components
			And reports all independently discoverable validation errors together
			And exits non-zero when any error exists
			And does not start components, create containers, or change configuration
	When the user runs `integral config validate --json`
		Then integral reports the same validation result as structured JSON

## CONFIG-6E28D1F9 — Reject unknown or malformed main options

Given the main configuration contains malformed TOML, a duplicate key, an unknown section, or an unknown option
	When integral validates or loads the file
		Then integral rejects the configuration
			And identifies the file and offending key or TOML location
			And does not silently ignore a likely typo

## CONFIG-D4A70C31 — Show effective configuration and value sources

Given built-in defaults, main configuration, and environment overrides may apply
	When the user runs `integral config show`
		Then integral prints the effective configuration
			And identifies each value as built-in, file, or environment sourced
			And includes component ports and connection names
			And formats human output as readable sections with one option per line
			And does not render sections as inline JSON objects
			And redacts credentials and internal component identities
	When the user runs `integral config show --json`
		Then integral returns the same effective values and sources as structured JSON

## CONFIG-39B8E2F6 — Apply configuration precedence consistently

Given a supported option has a built-in default
	And the main config may define that option
	And a documented environment override may define that option
	When integral resolves effective configuration
		Then the documented environment value wins when present
			And otherwise the main-config value wins when present
			And otherwise the built-in default applies
			And every server component uses the same precedence rules

## CONFIG-A16F73C8 — Configure component ports in the main file

Given `[server]` may define `gateway_port`, `coordinator_port`, and `runner_port`
	When integral resolves those options
		Then each value must be a decimal port from `1` through `65535`
			And the three effective ports must be distinct
			And their built-in defaults are `7310`, `7311`, and `7312`
			And matching `INTEGRAL_*_PORT` variables override file values

## CONFIG-E82C4A19 — Configure the Pi container image

Given `[runner]` may define `image` and `pull_policy`
	When integral resolves those options
		Then `image` must be a valid OCI image reference
			And its default is integral's automatically refreshed Pi image
			And `pull_policy` accepts only `always`, `if-not-present`, or `never`
			And its default is `if-not-present`
	When a custom image uses `pull_policy` `never`
		Then the runner uses an existing local image
			And refuses to start when the image is absent
	When a custom image uses `pull_policy` `if-not-present`
		Then the runner reuses an existing local image
			And otherwise pulls the configured image
	When a custom image uses `pull_policy` `always`
		Then the runner pulls the configured image before resolving its immutable identity

## CONFIG-4B97D20E — Configure runner timeouts

Given `[runner]` may define `turn_timeout_seconds` and `idle_timeout_seconds`
	When integral resolves those options
		Then each value must be a positive integer
			And `turn_timeout_seconds` defaults to `1800`
			And `idle_timeout_seconds` defaults to `300`
			And new or replacement Pi sessions use the resolved values
			And changing them does not retroactively move an existing deadline

## CONFIG-73E1A6B5 — Configure container resource limits

Given `[runner]` may define `memory_mb` and `tmpfs_mb`
	When integral resolves those options
		Then each value must be a positive integer
			And both values default to `2048`
			And the runner enforces `memory_mb` as the container memory limit
			And mounts `/tmp` with the `tmpfs_mb` size limit

## CONFIG-F2C84D16 — Configure restored conversation context

Given `[conversation]` may define `context_max_messages` and `context_max_chars`
	When integral starts a new or replacement Pi session
		Then both options must be non-negative integers
			And it considers only persisted user and assistant messages
			And it includes the newest contiguous suffix that fits both limits
			And it includes at most the configured number of newest persisted messages
			And includes at most the configured number of rendered characters
			And `context_max_messages` defaults to `200`
			And `context_max_chars` defaults to `100000`
			And zero for either limit disables restored context
			And session and error events are not supplied as Pi context
			And the full durable conversation remains available to terminal clients

## CONFIG-0C6A91E4 — Keep credentials out of configuration files

Given the main or connection configuration contains a literal credential field
	When integral validates or loads that file
		Then integral rejects the credential field
			And explains that credentials must be stored through `integral connection add`
			And does not copy the value into durable credential storage

## CONFIG-61F3D8B2 — Store connection declarations separately

Given the user successfully adds a connection named `<name>`
	When integral persists its non-secret declaration
		Then it writes `<INTEGRAL_HOME>/config/connections/<name>.toml` atomically
			And stores the provider or type, endpoint policy, auth method, and non-secret metadata
			And stores credential material only under the protected data area
			And requires the file stem and declared connection name to agree

## CONFIG-AC42E7D9 — Preserve connection configuration during rotation

Given a connection declaration contains valid operator-edited non-secret options
	When the user rotates its credential by adding that connection again
		Then integral replaces only credential material
			And leaves the connection file bytes unchanged
			And does not overwrite operator edits with catalog defaults

## CONFIG-7E19C4A6 — Apply main configuration at component startup

Given a server component is running with a valid main-config snapshot
	When the main configuration file changes
		Then the running component continues using its startup snapshot
			And `integral config validate` evaluates the new file independently
			And restarting the component applies the new valid configuration

## CONFIG-35D8A2F1 — Keep separate components on one effective configuration

Given server components start as separate processes under one `$INTEGRAL_HOME`
	When each component publishes ready state
		Then it publishes a fingerprint of its effective shared non-secret configuration
			And the fingerprint excludes component-local port environment overrides
	When component fingerprints disagree
		Then integral reports the deployment as degraded
			And the runner does not claim queued messages
			And status identifies the mismatched components

## CONFIG-E6B40A73 — Keep security invariants non-configurable

Given the user authors integral configuration
	When integral validates the configuration
		Then no option can enable direct container egress
			And no option can place real credentials in a container
			And no option can disable default-deny gateway behavior
			And no option can add grant or revoke semantics
			And no option can add another logical conversation to one `$INTEGRAL_HOME`

## CONFIG-58A1E7C3 — Reload connection declarations as one generation

Given server components are running
	When `integral connection add` or `integral connection rm` commits a valid declaration change
		Then integral assigns the connection snapshot a new monotonic generation
			And the gateway reloads all currently valid declarations and credentials
			And the coordinator mirrors the committed generation in component state
			And the runner reads current connections when it creates a Pi session
			And each component publishes the generation it has observed
			And the runner does not claim new messages while component generations disagree
			And no component observes a partially written connection declaration
	When a valid manual declaration edit changes the gateway's connection snapshot
		Then the gateway detects the changed snapshot
			And advances the generation when the CLI has not already done so

## CONFIG-B6D29F40 — Fail closed on an invalid connection-file edit

Given server components have a last known valid connection snapshot
	When a manual connection-file edit makes the connection configuration invalid
		Then the gateway continues using declarations that still validate
			And excludes the invalid declaration from its active candidates
			And publishes degraded health with the file error
			And the gateway does not admit new access from the invalid declaration
			And the runner does not claim new work while gateway health is degraded
	When the files become valid again
		Then components adopt the next complete connection generation

## CONFIG-1F84C6A2 — Write generated configuration safely

Given an integral command creates or replaces a configuration file
	When it commits the file
		Then it validates generated content before committing it
			And writes a complete temporary file in the destination directory
			And atomically renames it over the destination
			And applies owner-only write permissions

## CONFIG-48C2D7A1 — Validate common connection options

Given a connection file may define `name`, `kind`, `provider`, `url`, and `auth`
	When integral validates the connection
		Then `name` must contain at most 64 filesystem-safe letters, numbers, dots, underscores, or hyphens
			And must start with a letter or number
			And must be unique across loaded connection files
			And `kind` accepts only `model`, `http`, or `mcp`
			And `provider` is required for `model` and must name a catalog provider
			And `url` is required for `http` and `mcp` and must use HTTP or HTTPS
			And `auth` accepts only `oauth`, `device-code`, `key`, or `none`
			And generic connections must declare `auth` explicitly
			And model connections use the catalog auth default when `auth` is omitted
			And unknown connection options are rejected

## CONFIG-82E6A3F5 — Configure an HTTP connection boundary

Given an `http` connection file may define `url`, `methods`, and `path_prefix`
	When the gateway compiles that connection
		Then the URL defines its allowed scheme, host, and port
			And `methods` is a non-empty list of HTTP methods or `*`
			And omitted `methods` defaults to `*`
			And `path_prefix` may only narrow the URL's normalized path
			And requests outside the compiled boundary remain denied

## CONFIG-D17B4C90 — Configure key authentication without storing the key

Given a connection uses `auth = "key"`
	And its file may define `header` and `scheme`
	When integral validates the connection
		Then `header` defaults to `Authorization`
			And `scheme` defaults to `Bearer`
			And neither option may contain carriage returns or newlines
			And the actual key remains in protected credential storage

## CONFIG-6A90E2D4 — Configure OAuth authentication metadata

Given a generic connection uses `auth = "oauth"` or `auth = "device-code"`
	When integral validates its non-secret authentication metadata
		Then OAuth requires `authorization_url`, `token_url`, and `client_id`
			And device-code additionally requires `device_authorization_url`
			And `scopes` is an optional list of scope strings
			And endpoint URLs must use HTTPS unless they target loopback
			And client secrets and tokens remain outside configuration files

## CONFIG-3F7A81C6 — Configure a remote MCP transport

Given an `mcp` connection file may define `transport`
	When integral validates the connection
		Then `transport` accepts only `streamable-http` or `sse`
			And defaults to `streamable-http`
			And integral registers the configured transport and URL with Pi
			And replaces characters outside letters, numbers, and underscores when forming the Pi tool name
			And the gateway applies the connection's HTTP boundary and authentication
