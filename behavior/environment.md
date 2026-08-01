# Environment variable behaviors

These behaviors define the public host variables understood by rr and the
controlled environment constructed for Pi containers.

## ENV-2A7C4E91 — Select a deployment with RR_HOME

Given `RR_HOME` contains an absolute path
	When an rr command needs deployment state
		Then rr uses that path as the deployment root
			And keeps configuration under `<RR_HOME>/config`
			And keeps durable data under `<RR_HOME>/data`
			And keeps reconstructible runtime state under `<RR_HOME>/state`

## ENV-8D13B6F0 — Use the default deployment home

Given `RR_HOME` is unset or empty
	And `HOME` contains an absolute path
	When an rr command needs deployment state
		Then rr uses `<HOME>/.rr` as the deployment root
			And behaves as if that absolute path had been supplied through `RR_HOME`

## ENV-4C9E20A7 — Reject an invalid deployment home

Given an rr command needs deployment state
	When `RR_HOME` is set to a relative path
		Then rr exits non-zero before reading or writing deployment state
			And explains that `RR_HOME` must be absolute
	When both `RR_HOME` and `HOME` are unavailable
		Then rr exits non-zero before reading or writing deployment state
			And explains how to set `RR_HOME`

## ENV-B71F3D85 — Normalize deployment identity

Given two rr processes receive paths that resolve to the same deployment root
	When they resolve their deployment identity
		Then they use the same normalized absolute root
			And contend for the same per-component locks
			And attach to the same conversation and queue

## ENV-0E6A92C4 — Keep discovery commands independent of deployment state

Given `RR_HOME` and `HOME` are invalid or unavailable
	When the user runs `rr --help`
		Then the command succeeds without resolving a deployment root
	When the user runs `rr version`
		Then the command succeeds without resolving a deployment root
	When the user runs `rr connection catalog`
		Then the command succeeds without resolving a deployment root

## ENV-93D4A1B8 — Resolve rr variables once per process

Given an rr process has resolved its deployment root and component settings
	When its parent environment changes later
		Then the running process continues using the resolved values
			And does not switch deployment roots or ports
			And requires a new process to observe new values

## ENV-5F2C7E06 — Override component ports from the environment

Given `RR_GATEWAY_PORT`, `RR_COORDINATOR_PORT`, and `RR_RUNNER_PORT` contain distinct free decimal ports from `1` through `65535`
	And the main config may contain different component ports
	When the user runs `rr server start`
		Then the gateway binds to `RR_GATEWAY_PORT`
			And the coordinator binds to `RR_COORDINATOR_PORT`
			And the runner binds to `RR_RUNNER_PORT`
			And environment values take precedence over main-config values
			And rr records all bound component endpoints under the resolved `RR_HOME`

## ENV-C8A14D73 — Use default component ports

Given all three component port variables are unset or empty
	And the main config does not define component ports
	When the user runs `rr server start`
		Then the gateway uses port `7300`
			And the coordinator uses port `7301`
			And the runner uses port `7302`
			And rr records all bound component endpoints under the resolved `RR_HOME`

## ENV-17B6E9C2 — Reject invalid component ports

Given a component port variable is not a decimal integer from `1` through `65535`
	Or two component port variables contain the same port
	When the user starts any server component
		Then the command exits non-zero before publishing ready state
			And identifies every invalid or conflicting variable
			And does not silently choose or fall back to another port

## ENV-A4D8206F — Discover the coordinator from deployment state

Given a healthy coordinator recorded its endpoint under an `RR_HOME`
	When the user runs `rr talk` or another coordinator client with that same `RR_HOME`
		Then the client uses the recorded coordinator endpoint
			And does not require `RR_COORDINATOR_PORT` to be repeated
			And verifies the endpoint belongs to the expected deployment and component

## ENV-6C3F91E5 — Do not import ambient credentials

Given the host shell contains provider keys, tokens, or credential variables
	And no corresponding rr connection is configured
	When rr starts the server or provisions Pi
		Then rr does not treat those ambient variables as connections
			And does not copy them into the container
			And requires credentials to enter through `rr connection add`

## ENV-D20B7A48 — Build the container environment from an allowlist

Given the host shell contains arbitrary environment variables
	When rr provisions a Pi container
		Then rr constructs a new container environment from an explicit allowlist
			And does not inherit the host environment wholesale
			And excludes `RR_HOME`, `RR_GATEWAY_PORT`, `RR_COORDINATOR_PORT`, and `RR_RUNNER_PORT`
			And excludes host credential and authorization variables
			And uses container-specific values for `HOME`, `PATH`, and temporary storage

## ENV-3E85C1F9 — Route HTTP traffic through the gateway

Given rr provisions an authenticated Pi session
	When it constructs the container environment
		Then it sets `HTTP_PROXY` and `HTTPS_PROXY` to the session-authenticated gateway URL
			And sets `http_proxy` and `https_proxy` to the same URL
			And sets `NO_PROXY` and `no_proxy` to empty values
			And does not place a real connection credential in any proxy variable

## ENV-F19A64B2 — Configure CA trust inside the container

Given rr provisions a Pi container
	When it constructs the container environment
		Then it sets `NODE_EXTRA_CA_CERTS` to the mounted rr CA certificate
			And sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, and `PIP_CERT` to the mounted combined CA bundle
			And uses container paths rather than host paths
			And mounts the referenced certificate files read-only

## ENV-7B2D40AC — Protect rr-managed container variables

Given a connection name or configuration attempts to define a reserved variable
	And the reserved set includes `HOME`, `PATH`, proxy variables, CA variables, and names beginning with `RR_`
	When rr validates that connection or configuration
		Then rr rejects the conflicting definition
			And does not start a container with an overridden managed value

## ENV-E64A9C31 — Respect NO_COLOR in human output

Given `NO_COLOR` is present in the host environment
	When rr writes human-oriented CLI output
		Then rr emits no ANSI color sequences
			And leaves JSON output unchanged

## ENV-BC39A7D2 — Default each unset component port independently

Given one or more component port variables are explicitly configured
	And one or more component port variables are unset or empty
	When the user starts a server component
		Then rr uses environment values where present
			And otherwise uses that component's main-config value where present
			And otherwise uses that component's built-in default port
			And validates that the resulting three ports are distinct

## ENV-2E7A94C1 — Override one separately running component port

Given the user starts one component with `--component <name>`
	And its matching `RR_<NAME>_PORT` contains a valid free port
	When that component binds its listener
		Then it uses its matching environment override
			And does not require sibling component port variables to be repeated
			And publishes its actual endpoint for sibling discovery
