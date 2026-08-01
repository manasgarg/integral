# Failure behaviors

These behaviors cover failures spanning more than one product area.

## FAILURE-001 — Report an unexpected Pi exit

Given a chat turn is in progress
	When the Pi process or container exits unexpectedly
		Then the terminal reports that the response did not complete
			And does not present partial protocol output as a complete answer
			And removes the container and temporary session material

## FAILURE-002 — Report loss of the gateway

Given a chat container is running
	When the gateway becomes unavailable
		Then model calls fail visibly
			And rr does not fall back to direct internet access
			And rr does not place a real credential in the container
			And ending the chat still cleans up the container

## FAILURE-003 — Redact secrets from diagnostics

Given a CLI, gateway, provider, Docker, or Pi operation fails
	When rr renders an error or writes a diagnostic line
		Then it redacts credential values
			And redacts authorization headers
			And redacts proxy session tokens
			And redacts provider refresh tokens
