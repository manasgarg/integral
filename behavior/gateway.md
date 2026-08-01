# Gateway behaviors

These behaviors cover gateway identity, session authentication, connection
access, and the default-deny network boundary.

<!-- Automation note (GATEWAY-A2BBBBE8): Boundary matching, sentinel removal, credential injection, and forwarding construction are automated; a public TLS upstream is not contacted by the offline suite. -->
<!-- Automation note (GATEWAY-EC79406A): The default suite verifies the internal-network Docker specification; `npm run test:acceptance:docker` also verifies that a live container has no direct external route. -->

## GATEWAY-3F299566 — Verify the expected gateway

Given the rr gateway component is healthy
	When the CLI requests the gateway health endpoint
		Then the gateway returns success
			And identifies the current deployment
			And reports its current ready or degraded state
			And includes its current error when degraded
			And lets the CLI distinguish it from an unrelated process on the same port

## GATEWAY-578CEF2E — Reject an unauthenticated proxy request

Given the gateway is running
	When a client makes a proxy request without a valid active-session token
		Then the gateway returns HTTP 407 with a Basic proxy-authentication challenge
			And does not connect to the upstream host

## GATEWAY-B6C64AA7 — Attribute an authenticated request

Given an active chat has a unique session token
	When its container sends a request through the gateway
		Then the container supplies the token as the password in Basic proxy authentication
			And the gateway associates the request with that chat session
			And removes proxy authorization and proxy connection headers before forwarding
			And rejects the token after the session ends

## GATEWAY-A2BBBBE8 — Forward a request allowed by an active connection

Given an authenticated chat container is active
	And its request matches an active connection's scheme policy
	And its request matches that connection's host and port policy
	And its request matches that connection's method and path policy
	When Pi sends the request through the gateway
		Then the gateway establishes a verified upstream TLS connection
			And replaces the managed sentinel with the connection's real credential when authentication requires it
			And refuses a caller-supplied credential that is not the rr sentinel
			And forwards the upstream response to Pi
			And does not log the real credential

## GATEWAY-EB8D96FE — Deny destinations outside active connections

Given an authenticated chat container is active
	When it requests a destination outside every active connection boundary
		Then the gateway returns HTTP 403
			And states that policy denied the request
			And does not contact the requested upstream
	When it requests an HTTPS tunnel
		Then the gateway accepts `CONNECT` only on port 443
			And refuses the tunnel before interception unless an active HTTPS connection can match its host and port
			And still applies method and path policy to each intercepted request

## GATEWAY-123EDBDF — Fail closed when injection cannot be completed

Given a request matches an active credentialed connection
	And its credential file is missing
	Or its recognized OAuth credential cannot be refreshed
	When the gateway evaluates the request
		Then it refuses the request
			And does not forward the sentinel upstream
			And tells the user to rotate or reconfigure the connection

## GATEWAY-EC79406A — Prevent direct container egress

Given a chat container is running
	When software in the container attempts internet access without the gateway
		Then the connection cannot reach the destination
			And rr fails container startup when it cannot create the locked network
