# Server behaviors

These behaviors cover the trusted foreground process that owns the gateway.

## SERVER-001 — Start a healthy foreground server

Given Docker is available
	And a usable model credential is configured
	And no rr server is running for this deployment
	When the user runs `rr server start`
		Then rr starts the gateway on loopback
			And starts the gateway on the Docker host-gateway address
			And reports that the server is ready
			And remains in the foreground until interrupted

## SERVER-002 — Reject a second server

Given a healthy rr server is running for this deployment
	When the user runs `rr server start` again
		Then the second command exits non-zero
			And reports that the existing server owns the deployment lock
			And does not disturb the existing server

## SERVER-003 — Fail clearly when Docker is unavailable

Given the Docker daemon cannot be reached
	When the user runs `rr server start`
		Then startup exits non-zero
			And identifies Docker as unavailable
			And does not publish gateway-ready state

## SERVER-004 — Stop the server cleanly

Given the foreground server is running
	When it receives SIGINT or SIGTERM
		Then it stops accepting gateway connections
			And terminates any active chat container
			And revokes temporary session identity material
			And removes temporary session identity material
			And removes its lock and ready-state files
			And exits without leaving a rr container running
