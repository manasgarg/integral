# Environment variable behaviors

These behaviors define the public host variables understood by integral and the
controlled environment constructed for Pi containers.

## ENV-2A7C4E91 — Select a deployment with INTEGRAL_HOME

Given `INTEGRAL_HOME` contains an absolute path
	When an integral command needs deployment state
		Then integral uses that path as the deployment root
			And keeps configuration under `<INTEGRAL_HOME>/config`
			And keeps durable data under `<INTEGRAL_HOME>/data`
			And keeps reconstructible runtime state under `<INTEGRAL_HOME>/state`

## ENV-8D13B6F0 — Use the default deployment home

Given `INTEGRAL_HOME` is unset or empty
	And `HOME` contains an absolute path
	When an integral command needs deployment state
		Then integral uses `<HOME>/.integral` as the deployment root
			And behaves as if that absolute path had been supplied through `INTEGRAL_HOME`

## ENV-4C9E20A7 — Reject an invalid deployment home

Given an integral command needs deployment state
	When `INTEGRAL_HOME` is set to a relative path
		Then integral exits non-zero before reading or writing deployment state
			And explains that `INTEGRAL_HOME` must be absolute
	When both `INTEGRAL_HOME` and `HOME` are unavailable
		Then integral exits non-zero before reading or writing deployment state
			And explains how to set `INTEGRAL_HOME`

## ENV-B71F3D85 — Normalize deployment identity

Given two integral processes receive paths that resolve to the same deployment root
	When they resolve their deployment identity
		Then they use the same normalized absolute root
			And contend for the same per-component locks
			And resolve the same durable conversation registry and per-conversation queues

## ENV-0E6A92C4 — Keep discovery commands independent of deployment state

Given `INTEGRAL_HOME` and `HOME` are invalid or unavailable
	When the user runs `integral --help`
		Then the command succeeds without resolving a deployment root
	When the user runs `integral version`
		Then the command succeeds without resolving a deployment root
	When the user runs `integral connection catalog`
		Then the command succeeds without resolving a deployment root

## ENV-93D4A1B8 — Resolve integral variables once per process

Given an integral process has resolved its deployment root and component settings
	When its parent environment changes later
		Then the running process continues using the resolved values
			And does not switch deployment roots or ports
			And requires a new process to observe new values

## ENV-5F2C7E06 — Override component ports from the environment

Given `INTEGRAL_GATEWAY_PORT`, `INTEGRAL_COORDINATOR_PORT`, `INTEGRAL_RUNNER_PORT`, and `INTEGRAL_SCHEDULER_PORT` contain distinct free decimal ports from `1` through `65535`
	And the main config may contain different component ports
	When the user runs `integral server start`
		Then the gateway binds to `INTEGRAL_GATEWAY_PORT`
			And the coordinator binds to `INTEGRAL_COORDINATOR_PORT`
			And the runner binds to `INTEGRAL_RUNNER_PORT`
			And the scheduler binds to `INTEGRAL_SCHEDULER_PORT`
			And environment values take precedence over main-config values
			And integral records all bound component endpoints under the resolved `INTEGRAL_HOME`

## ENV-C8A14D73 — Use default component ports

Given all four component port variables are unset or empty
	And the main config does not define component ports
	When the user runs `integral server start`
		Then the gateway uses port `7310`
			And the coordinator uses port `7311`
			And the runner uses port `7312`
			And the scheduler uses port `7313`
			And integral records all bound component endpoints under the resolved `INTEGRAL_HOME`

## ENV-17B6E9C2 — Reject invalid component ports

Given a component port variable is not a decimal integer from `1` through `65535`
	Or two component port variables contain the same port
	When the user starts any server component
		Then the command exits non-zero before publishing ready state
			And identifies every invalid or conflicting variable
			And does not silently choose or fall back to another port

## ENV-A4D8206F — Discover the coordinator from deployment state

Given a healthy coordinator recorded its endpoint under an `INTEGRAL_HOME`
	When the user runs `integral talk` or another coordinator client with that same `INTEGRAL_HOME`
		Then the client uses the recorded coordinator endpoint
			And does not require `INTEGRAL_COORDINATOR_PORT` to be repeated
			And verifies the endpoint belongs to the expected deployment and component

## ENV-6C3F91E5 — Do not import ambient credentials

Given the host shell contains provider keys, tokens, or credential variables
	And no corresponding integral connection is configured
	When integral starts the server or provisions Pi
		Then integral does not treat those ambient variables as connections
			And does not copy them into the container
			And requires credentials to enter through `integral connection add`

## ENV-D20B7A48 — Build the container environment from an allowlist

Given the host shell contains arbitrary environment variables
	When integral provisions a Pi container
		Then integral constructs a new container environment from an explicit allowlist
			And does not inherit the host environment wholesale
			And excludes `INTEGRAL_HOME`, `INTEGRAL_GATEWAY_PORT`, `INTEGRAL_COORDINATOR_PORT`, and `INTEGRAL_RUNNER_PORT`
			And excludes host credential and authorization variables
			And sets `HOME` to `/home/pi`
			And sets `PATH` to `/usr/local/bin:/usr/bin:/bin`
			And sets `TMPDIR` to `/tmp`

## ENV-3E85C1F9 — Route HTTP traffic through the gateway

Given integral provisions an authenticated Pi session
	When it constructs the container environment
		Then it sets `HTTP_PROXY` and `HTTPS_PROXY` to the session-authenticated gateway URL
			And sets `http_proxy` and `https_proxy` to the same URL
			And sets `NO_PROXY` and `no_proxy` to empty values
			And does not place a real connection credential in any proxy variable

## ENV-F19A64B2 — Configure CA trust inside the container

Given integral provisions a Pi container
	When it constructs the container environment
		Then it sets `NODE_EXTRA_CA_CERTS` to the mounted integral CA certificate
			And sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, and `PIP_CERT` to the mounted combined CA bundle
			And uses container paths rather than host paths
			And mounts the referenced certificate files read-only
	When the deployment CA does not exist
		Then integral creates one under the deployment data directory
			And builds a trust bundle from available system roots plus the integral CA
			And does not mount the CA private key into the container
	When the gateway intercepts an allowed HTTPS host for the first time
		Then integral creates and caches a host certificate signed by the deployment CA

## ENV-7B2D40AC — Protect integral-managed container variables

Given a connection name or configuration attempts to define a reserved variable
	And the reserved set includes `HOME`, `PATH`, proxy variables, CA variables, and names beginning with `INTEGRAL_`
	When integral validates that connection or configuration
		Then integral rejects the conflicting definition
			And does not start a container with an overridden managed value

## ENV-E64A9C31 — Respect NO_COLOR in human output

Given `NO_COLOR` is present in the host environment
	When integral writes human-oriented CLI output
		Then integral emits no ANSI color sequences
			And leaves JSON output unchanged

## ENV-BC39A7D2 — Default each unset component port independently

Given one or more component port variables are explicitly configured
	And one or more component port variables are unset or empty
	When the user starts a server component
		Then integral uses environment values where present
			And otherwise uses that component's main-config value where present
			And otherwise uses that component's built-in default port
			And validates that the resulting four ports are distinct

## ENV-2E7A94C1 — Override one separately running component port

Given the user starts one component with `--component <name>`
	And its matching `INTEGRAL_<NAME>_PORT` contains a valid free port
	When that component binds its listener
		Then it uses its matching environment override
			And does not require sibling component port variables to be repeated
			And publishes its actual endpoint for sibling discovery

## ENV-9A4C17E2 — Override logging from the environment

Given logging environment variables may be set
	When `INTEGRAL_LOG_LEVEL` contains `error`, `warn`, `info`, `debug`, or `trace`
		And `INTEGRAL_LOG_FORMAT` contains `text` or `json`
		Then the environment values override `[logging]` file values
			And the Pi container does not inherit either variable
	When one variable contains a supported value and the other is unset or empty
		Then integral overrides only the supplied logging option
			And resolves the other option from main config or its built-in default
	When either variable contains an unsupported value
		Then the process exits non-zero before performing its operation
