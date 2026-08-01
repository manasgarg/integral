# Server behaviors

These behaviors cover the coordinator, runner, and gateway components in
combined and separate-process modes.

<!-- Automation note (SERVER-F886D80C): Combined orchestration and cleanup run in the default suite; `npm run test:acceptance` launches the real foreground CLI with a controlled Docker boundary. -->
<!-- Automation note (SERVER-A74F29C1): Deployment identity, locks, credentials, and state isolation are automated; two live Docker deployments require a Docker-enabled acceptance host. -->
<!-- Automation note (SERVER-FE2BB5CF): Docker dependency placement is automated by component contract tests; daemon failure is not induced against a live daemon. -->
<!-- Automation note (SERVER-33E00BBA): Lifecycle cleanup runs in the default suite; `npm run test:acceptance` delivers SIGTERM to the real foreground CLI and verifies owned deployment-state cleanup. -->
<!-- Automation note (SERVER-8A31D6C4): Separate component construction and network boundaries are automated in-process; three foreground OS processes are not spawned by the restricted default test runner. -->
<!-- Automation note (SERVER-E3A74B10): Per-component ownership and cleanup are automated; live process signaling is reserved for an acceptance environment. -->

## SERVER-F886D80C — Start all components in one foreground process

Given Docker is available
	And at least one active model connection exists
	And no server component is running for this deployment
	When the user runs `integral server start`
		Then integral validates that an active model connection and the Docker daemon are available before starting listeners
			And does not select a model connection or model
			And starts the coordinator, gateway, and runner in that order in one process
			And each component listens on its own configured port
			And publishes each component as ready after its listener starts
			And reports the deployment healthy only when all three ready states agree
			And remains in the foreground until interrupted

## SERVER-DF5FD52E — Reject a duplicate component for the same deployment

Given a server component is running for a deployment
	When another process starts that same component with the same `$INTEGRAL_HOME`
		Then the second process exits non-zero
			And reports that the component lock is already held
			And does not disturb any running component
	When the lock file names a process that no longer exists
		Then integral removes the stale lock
			And lets the new component acquire it

## SERVER-A74F29C1 — Run independent deployments on one machine

Given two integral deployments use different `$INTEGRAL_HOME` roots
	And all component ports are distinct within and across the two deployments
	When the user starts both servers
		Then both servers become healthy
			And each component holds a lock only within its own `$INTEGRAL_HOME`
			And each server uses only its own configuration and credentials
			And each server uses its own CA, state, session tokens, network, and containers
			And stopping one server does not disturb the other

## SERVER-FE2BB5CF — Require Docker only for the runner

Given the Docker daemon cannot be reached
	When the user runs `integral server start`
		Then startup exits non-zero
			And identifies Docker as unavailable
			And does not publish gateway-ready state
	When the user starts only the runner component
		Then the runner exits non-zero and identifies Docker as unavailable
	When the user starts only the coordinator or gateway component
		Then that component may become healthy without Docker

## SERVER-33E00BBA — Stop the combined server cleanly

Given all components are running in one foreground process
	When it receives SIGINT or SIGTERM
		Then it stops owned components in reverse startup order
			And stops all three component listeners
			And durably returns any interrupted in-flight message to the queue
			And terminates any active chat container
			And revokes temporary session identity material
			And removes its lock and ready-state files
			And exits without leaving a integral container running

## SERVER-2C8F41A7 — Show component startup options

Given integral is installed
	When the user runs `integral server start --help`
		Then the command describes combined mode as the default
			And lists `coordinator`, `runner`, and `gateway` as component values
			And describes `--component <name>` as single-component mode

## SERVER-8A31D6C4 — Run each component in a separate process

Given no server component is running for the deployment
	When the user starts `integral server start --component coordinator`
		Then that process starts only the coordinator listener
	When the user starts `integral server start --component runner`
		Then that process starts only the runner listener
	When the user starts `integral server start --component gateway`
		Then that process starts only the gateway listener
	When all three component processes are healthy
		Then the deployment offers the same behavior as combined mode

## SERVER-0D7E29B5 — Keep component network boundaries in combined mode

Given integral is running all components in one process
	When a component calls another component
		Then it uses the same authenticated network interface used in separate mode
			And does not replace the component boundary with direct in-memory calls
			And each component remains independently health-checkable on its own port

## SERVER-51C9A3E8 — Discover sibling components through deployment state

Given one component has published its endpoint under an `$INTEGRAL_HOME`
	When another component starts with that same `$INTEGRAL_HOME`
		Then it discovers the published endpoint from deployment state
			And verifies the endpoint belongs to the expected deployment and component
			And does not require component endpoint arguments to be repeated

## SERVER-B4E20F76 — Start separate components in any order

Given the three components will run as separate processes
	When the coordinator starts before the runner or gateway
		Then it becomes available for terminal attachment and durable queue mutations
			And reports unavailable dependencies as degraded
	When the runner starts before the gateway
		Then it does not claim queued messages until governed egress is healthy
	When missing components later become healthy
		Then the deployment begins processing queued messages without restarting healthy components

## SERVER-6F18C2D9 — Isolate separate component failures

Given coordinator, runner, and gateway run in separate processes
	When one component exits
		Then the other component processes remain running
			And their health reports identify the missing dependency
			And acknowledged queue and conversation state remain durable

## SERVER-E3A74B10 — Stop one separately running component

Given coordinator, runner, and gateway run in separate processes
	When the runner stops
		Then it durably returns any interrupted in-flight message to the coordinator queue
			And terminates its Pi container
			And does not stop the coordinator or gateway
	When the coordinator or gateway stops
		Then it does not signal the other component processes to exit
	When any separate component stops cleanly
		Then it removes only its own ready-state record and component lock

## SERVER-9D42E6A3 — Reject conflicting component ports

Given two or more component port settings resolve to the same port
	When any server component validates the deployment
		Then it exits non-zero before publishing ready state
			And identifies the conflicting component settings
			And does not silently choose another port

## SERVER-3B7F90C2 — Report aggregate and component health

Given one or more server components are running
	When the user runs `integral server status`
		Then integral probes each recorded health endpoint with a bounded timeout
			And treats missing, unreachable, or identity-mismatched endpoints as stopped
			And reports coordinator, runner, and gateway health separately
			And reports whether the deployment is healthy or degraded overall
			And produces the same status model in combined and separate modes
			And exits successfully only when the overall deployment is healthy
	When the user runs `integral server status --json`
		Then integral returns the same overall and component status as structured JSON
Given no recorded component answers a valid health probe
	When the user runs `integral server status`
		Then integral reports the deployment and all three components as stopped
			And exits non-zero

## SERVER-7C21D5E8 — Bind each component only where required

Given integral starts the server components
	When it binds their listeners
		Then the coordinator and runner listen on loopback only
			And the gateway initially listens on loopback
			And the runner asks it to add the deployment Docker-network gateway address
			And no component listens on every host interface by default

## SERVER-C6A830F4 — Fail combined startup atomically

Given integral is starting all components in one process
	When any component cannot bind, validate, or become ready
		Then the process stops every component it started
			And removes every ready-state record and lock it created
			And exits non-zero without reporting the deployment healthy

## SERVER-4E19B7A6 — Authenticate component-to-component requests

Given server components communicate over their distinct listeners
	When a component sends an internal request
		Then it sends a shared deployment-scoped bearer identity
			And identifies the calling component in a separate header
			And the receiver verifies the bearer identity, expected deployment, and expected caller
	When a request has missing, invalid, or cross-deployment component identity
		Then the receiving component refuses it without changing state
