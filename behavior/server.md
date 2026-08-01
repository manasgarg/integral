# Server behaviors

These behaviors cover the trusted foreground process that owns the gateway.

## SERVER-F886D80C — Start a healthy foreground server

Given Docker is available
	And an active model connection is configured
	And no rr server is running for this deployment
	When the user runs `rr server start`
		Then rr starts the gateway on loopback
			And starts the gateway on the Docker host-gateway address
			And reports that the server is ready
			And remains in the foreground until interrupted

## SERVER-DF5FD52E — Reject a second server for the same deployment

Given a healthy rr server is running for this deployment
	When the user runs `rr server start` again with the same `$RR_HOME`
		Then the second command exits non-zero
			And reports that the existing server owns the deployment lock
			And does not disturb the existing server

## SERVER-A74F29C1 — Run independent deployments on one machine

Given two rr deployments use different `$RR_HOME` roots
	And each deployment is configured with a different free gateway port
	When the user starts both servers
		Then both servers become healthy
			And each server holds a lock only within its own `$RR_HOME`
			And each server uses only its own configuration and credentials
			And each server uses its own CA, state, session tokens, network, and containers
			And stopping one server does not disturb the other

## SERVER-FE2BB5CF — Fail clearly when Docker is unavailable

Given the Docker daemon cannot be reached
	When the user runs `rr server start`
		Then startup exits non-zero
			And identifies Docker as unavailable
			And does not publish gateway-ready state

## SERVER-33E00BBA — Stop the server cleanly

Given the foreground server is running
	When it receives SIGINT or SIGTERM
		Then it stops accepting gateway connections
			And durably returns any interrupted in-flight message to the queue
			And terminates any active chat container
			And revokes temporary session identity material
			And removes temporary session identity material
			And removes its lock and ready-state files
			And exits without leaving a rr container running
