# Gateway behaviors

These behaviors cover gateway identity, session authentication, model access,
and the default-deny network boundary.

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

## GATEWAY-A2BBBBE8 — Forward an allowed model request

Given an authenticated chat container is active
	And its request matches the configured provider's built-in host policy
	And its request matches the configured provider's port policy
	And its request matches the configured provider's method policy
	And its request matches the configured provider's path policy
	When Pi sends the request through the gateway with its sentinel credential
		Then the gateway establishes a verified upstream TLS connection
			And removes the sentinel credential
			And injects the real credential in the provider-required location
			And forwards the upstream response to Pi
			And does not log the real credential

## GATEWAY-EB8D96FE — Deny destinations outside model policy

Given an authenticated chat container is active
	When it requests a host, port, method, or path outside built-in model policy
		Then the gateway returns HTTP 403
			And states that policy denied the request
			And does not contact the requested upstream

## GATEWAY-123EDBDF — Fail closed when injection cannot be completed

Given a request matches the built-in model policy
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
