# Gateway behaviors

These behaviors cover gateway identity, session authentication, connection
access, and the default-deny network boundary.

<!-- Automation note (GATEWAY-A2BBBBE8): Boundary matching, sentinel removal, credential injection, and forwarding construction are automated; a public TLS upstream is not contacted by the offline suite. -->
<!-- Automation note (GATEWAY-EC79406A): The default suite verifies the internal-network Docker specification; `npm run test:acceptance:docker` also verifies that a live container has no direct external route. -->
<!-- Automation note (GATEWAY-846B1000): Durable approval creation, terminal decisions, restart recovery, exact-once package execution, and replacement-session continuation are automated at component boundaries. -->

## GATEWAY-3F299566 — Verify the expected gateway

Given the integral gateway component is healthy
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
			And refuses a caller-supplied credential that is not the integral sentinel
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
			And integral fails container startup when it cannot create the locked network

## GATEWAY-846B1000 — Require human approval for governed mutations

Given the gateway classifies a control operation as requiring human approval
	And container package installation and upgrade are approval-required
	And writes to repositories with host-managed `approval-required` policy are approval-required
	And fresh image rebuilds that can resolve floating dependencies are approval-required
	And read-only package inventory is not approval-required
	And read-only repository operations are not approval-required
	When an authenticated Pi session submits an approval-required request
		Then Integral validates it without executing it
			And durably records an unpredictable approval ID, safe summary, canonical request digest, originating actor, session and run, model selection, current revision, and deadline
			And broadcasts the pending approval to every attached human terminal
			And includes it in snapshots for terminals that attach later
			And keeps the originating tool call pending while its connection remains active
			And does not build an image, advance a protected repository ref, or modify package state before approval
Given an authenticated host user or automation submits an approval-required request outside Pi
	When Integral creates the approval request
		Then it records the external actor and request origin without inventing a Pi session or run
			And applies the same validation, decision, execution, audit, expiry, and restart lifecycle
Given an approval request is pending
	When an attached human runs `/approve <approval-id>`
		Then Integral binds the decision to that terminal attachment
			And revalidates the exact request and expected revision
			And executes it exactly once using the approval ID as its idempotency key
			And durably records and broadcasts the result or failure
	When an attached human runs `/deny <approval-id>`
		Then Integral binds the decision to that terminal attachment
			And durably records and broadcasts the denial
			And does not execute the request
	When another human attempts to decide the resolved approval
		Then Integral rejects the later decision
			And does not execute the request again
	When the request revision is stale at approval time
		Then Integral records and broadcasts a stale outcome
			And does not execute the request
	When the request is a fresh rebuild with floating dependencies
		Then Integral shows the active recipe commit, prior image digest, mutable inputs, and build-time resolution warning
			And approval authorizes resolution against the configured repositories at execution time rather than an exact dependency closure
Given an approval is resolved while its originating Pi tool call remains connected
	When Integral completes the decision
		Then it returns the durable outcome to that tool call
			And does not create a replacement session solely for the outcome
Given an approval remains unresolved after its originating Pi session ends
	When the session ends
		Then Integral keeps the approval open
			And revokes the ended session's temporary credentials
			And retains the exact request, originating session and run, and model selection
	When a human later approves, denies, or lets the request expire
		Then Integral durably queues an approval-resolution continuation
			And starts a new Pi session using the resulting current image and model
			And gives it the approval ID, safe action summary, and outcome
			And restores the preceding conversation context
			And records the ended session and run as its parent lineage
Given Integral restarts with unresolved approvals
	When the coordinator recovers durable state
		Then it preserves every unresolved approval in its prior state
			And does not cancel, deny, approve, or execute it merely because Integral restarted
			And republishes it to attached human terminals
	When it recovers a durably approved operation without a durable execution result
		Then it resumes execution using the approval ID
			And prevents duplicate package-state or protected-repository changes
Given an unresolved approval reaches its ten-minute deadline
	When Integral expires it
		Then Integral records and broadcasts an expired outcome without executing the request
			And never approves it automatically
			And delivers the outcome through the live tool call or a replacement-session continuation
When an approval changes state
	Then Integral writes a durable audit record with its safe summary, request digest, lineage, decision identity, execution state, and timestamps
		And never records credentials or secret request values
