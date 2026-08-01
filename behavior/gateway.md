# Gateway behaviors

These behaviors cover gateway identity, session authentication, connection
access, and the default-deny network boundary.

## GATEWAY-3F299566 — Verify the expected gateway

Given the rr server is healthy
	When the CLI requests the gateway health endpoint
		Then the gateway returns success
			And identifies the current deployment
			And lets the CLI distinguish it from an unrelated process on the same port

## GATEWAY-578CEF2E — Reject an unauthenticated proxy request

Given the gateway is running
	When a client makes a proxy request without a valid active-session token
		Then the gateway refuses the request
			And does not connect to the upstream host

## GATEWAY-B6C64AA7 — Attribute an authenticated request

Given an active chat has a unique session token
	When its container sends a request through the gateway
		Then the gateway associates the request with that chat session
			And rejects the token after the session ends

## GATEWAY-A2BBBBE8 — Forward a request allowed by an active connection

Given an authenticated chat container is active
	And its request matches an active connection's scheme policy
	And its request matches that connection's host and port policy
	And its request matches that connection's method and path policy
	When Pi sends the request through the gateway
		Then the gateway establishes a verified upstream TLS connection
			And removes any sentinel credential
			And injects the connection's real credential when authentication requires it
			And forwards the upstream response to Pi
			And does not log the real credential

## GATEWAY-EB8D96FE — Deny destinations outside active connections

Given an authenticated chat container is active
	When it requests a destination outside every active connection boundary
		Then the gateway returns HTTP 403
			And states that policy denied the request
			And does not contact the requested upstream

## GATEWAY-123EDBDF — Fail closed when injection cannot be completed

Given a request matches an active credentialed connection
	And the active connection's credential is missing, expired, or unusable
	When the gateway evaluates the request
		Then it refuses the request
			And does not forward the sentinel upstream
			And tells the user to rotate or reconfigure the connection

## GATEWAY-EC79406A — Prevent direct container egress

Given a chat container is running
	When software in the container attempts internet access without the gateway
		Then the connection cannot reach the destination
			And rr fails container startup when it cannot create the locked network
