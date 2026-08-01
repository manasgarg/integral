# Failure behaviors

These behaviors cover failures spanning more than one product area.

<!-- Automation note (FAILURE-071CB99A): Interruption, durable release, and cleanup paths are automated at the runner/coordinator boundary; killing a real Pi container requires Docker. -->
<!-- Automation note (FAILURE-3780301D): Fail-closed gateway-loss handling is automated at component boundaries; a live mid-request gateway kill requires Docker and process-control acceptance infrastructure. -->

## FAILURE-071CB99A — Report an unexpected Pi exit

Given a chat turn is in progress
	When the Pi process or container exits unexpectedly
		Then rr records that the response did not complete
			And reports the interruption to every attached terminal
			And does not present partial protocol output as a complete answer
			And durably returns the interrupted message to the queue
			And removes the container and temporary session material

## FAILURE-3780301D — Report loss of the gateway

Given a chat container is running
	When the gateway becomes unavailable
		Then model calls fail visibly
			And rr does not fall back to direct internet access
			And rr does not place a real credential in the container
			And the runner ends the failed Pi turn and removes its container
			And the coordinator durably returns the interrupted message to the queue

## FAILURE-282E3B57 — Redact secrets from diagnostics

Given a CLI, gateway, provider, Docker, or Pi operation fails
	When rr renders an error or writes a diagnostic line
		Then it redacts credential values
			And redacts authorization headers
			And redacts proxy session tokens
			And redacts provider refresh tokens
