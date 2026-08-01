# Failure behaviors

These behaviors cover failures spanning more than one product area.

<!-- Automation note (FAILURE-071CB99A): Interruption, durable release, and cleanup paths are automated at the runner/coordinator boundary; killing a real Pi container requires Docker. -->
<!-- Automation note (FAILURE-3780301D): Fail-closed gateway-loss handling is automated at component boundaries; a live mid-request gateway kill requires Docker and process-control acceptance infrastructure. -->
<!-- Automation note (FAILURE-A4C19E72): Immediate RPC rejection is automated at the Pi protocol boundary without a live provider call. -->

## FAILURE-071CB99A — Report an unexpected Pi exit

Given a chat turn is in progress
	When the Pi process or container exits unexpectedly
		Then integral records that the response did not complete
			And reports the interruption to every attached terminal
			And does not present partial protocol output as a complete answer
			And durably returns the interrupted message to the queue
			And removes the container and temporary session material

## FAILURE-3780301D — Report loss of the gateway

Given the runner has not claimed its next message
	When gateway state is missing or not ready
		Then the runner marks itself degraded
			And does not claim new work
			And does not fall back to direct internet access
Given a chat turn is already in progress
	When the prompt fails with a gateway, container, timeout, or exit error
		Then the runner removes the failed Pi container
			And integral does not place a real credential in any replacement container
			And the coordinator durably returns the interrupted message to the queue
			And reports the turn error to attached terminals

## FAILURE-A4C19E72 — Handle an immediate Pi prompt rejection

Given the runner has sent a claimed message to Pi
	When Pi rejects the prompt before beginning a turn
		Then integral reports the rejection without waiting for the turn timeout
			And durably returns the interrupted message to the queue
			And removes the failed Pi container and temporary session material

## FAILURE-282E3B57 — Redact known secrets from component diagnostics

Given the component logger knows the deployment's stored credential values
	When a gateway, provider, Docker, or Pi operation writes a diagnostic event
		Then it redacts those known credential values wherever they occur
			And redacts values under authorization, cookie, secret, token, password, and API-key fields
			And redacts inline Basic and Bearer authorization values
			And emits the sanitized event in the configured format
