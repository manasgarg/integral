# MCP behaviors

These behaviors define generalized remote and stdio MCP connections. Integral
acts as the MCP client, while credentials and unrestricted network access remain
outside Pi containers. MCP Apps, prompts, resources, and per-conversation enable
switches are outside this scope.

<!-- Automation note (MCP-948B2522): OAuth metadata discovery, dynamic registration, issuer/resource binding, and refresh are covered by MCP, OAuth, connection, and gateway tests. -->
<!-- Automation note (MCP-DB6BD516): Stateless, sessionful, and legacy SSE negotiation are covered by MCP protocol tests. -->
<!-- Automation note (MCP-007BCE08): Paginated discovery, malformed-tool isolation, deterministic first-class tool generation, and schema bounds are covered by MCP and container tests. -->
<!-- Automation note (MCP-2F0F5CB5): Named remote invocation and stdio gateway brokering are covered by MCP and gateway/container tests. -->
<!-- Automation note (MCP-0A804DA4): Stdio configuration, secret handling, locked sidecar construction, protocol supervision, and session cleanup are covered by connection, CLI, container, and runner tests. -->

## MCP-948B2522 — Discover and complete MCP authorization

Given a remote MCP server responds that authorization is required
	When integral adds or reconnects the server
		Then integral discovers its protected-resource metadata
			And discovers and validates the authorization server metadata
			And binds discovered client registration and tokens to that authorization-server issuer
			And prefers configured client information when supplied
			And otherwise uses a supported MCP client-registration mechanism
			And uses authorization code with PKCE
			And includes the MCP resource indicator in authorization and token requests
			And requests only the scopes advertised as necessary for the MCP resource
			And validates authorization state, issuer, redirect URI, and resource binding
			And accepts a loopback callback or a pasted authorization response
			And stores client credentials, access tokens, and refresh tokens only in the host credential area
			And never places a real credential in a Pi environment, file, argument, tool declaration, or MCP payload
	When an access token is near expiry
		Then integral refreshes it before the next MCP request
			And atomically stores the replacement token record
	When authorization discovery is incomplete or inconsistent
		Then integral refuses the connection
			And identifies the incompatible metadata without exposing secrets

## MCP-DB6BD516 — Negotiate compatible remote MCP protocols

Given an active remote MCP connection
	When integral opens communication with its server
		Then integral supports the MCP `2026-07-28` stateless HTTP protocol
			And supports the sessionful `2025-11-25` protocol family
			And supports the legacy `2024-11-05` HTTP+SSE transport
			And selects the newest mutually supported protocol
			And sends the protocol, routing, client identity, capability, and session metadata required by the selected version
			And follows the selected version's request, response, cancellation, and shutdown lifecycle
	When a sessionful server assigns an MCP session identifier
		Then integral returns that identifier only to the same connection and server boundary
			And reinitializes after the server expires the session
			And attempts orderly session termination when the Pi session ends
	When a server cannot negotiate any supported version
		Then integral marks that connection unavailable
			And does not send a tool request using guessed protocol semantics

## MCP-007BCE08 — Expose discovered MCP tools as first-class Pi tools

Given an active MCP server advertises one or more tools
	When integral prepares a Pi session
		Then integral reads every page of the server's tool catalog
			And registers one Pi tool for each valid remote tool
			And preserves the remote tool's name when making MCP requests
			And gives the Pi tool a deterministic name namespaced by connection
			And exposes the remote title, description, input schema, output schema, and annotations supported by Pi
			And supports JSON Schema 2020-12 input schemas within documented resource limits
			And prevents one connection's names from colliding with Integral tools or another connection's tools
			And does not expose a generic `mcp_<server>` tool that requires Pi to guess a remote tool name
	When a remote tool declaration is malformed, duplicated, or exceeds a documented schema limit
		Then integral excludes that tool
			And reports a bounded diagnostic identifying its connection and tool
			And keeps other valid tools from the same server available

## MCP-2F0F5CB5 — Invoke a discovered MCP tool faithfully

Given Pi invokes a tool discovered from an MCP connection
	When integral handles the invocation
		Then integral validates the arguments against the advertised input schema
			And sends `tools/call` to the originating connection and server tool
			And routes the request over the connection's negotiated remote or stdio transport
			And sends a remote request only through the authenticated Integral gateway
			And injects a remote credential only after matching the connection's scheme, host, port, and path boundary
			And preserves supported text, image, audio, resource-link, embedded-resource, and structured result content
			And represents an MCP tool execution error as a tool result that Pi can reason about
			And represents a transport or protocol failure without exposing credentials or unrestricted response data
	When Pi cancels the invocation
		Then integral propagates cancellation according to the negotiated MCP version
			And stops waiting for the result
			And does not treat cancellation as successful tool execution
	When the remote server redirects a request outside the declared connection boundary
		Then the gateway refuses the redirect
			And does not forward the credential to the new destination

## MCP-5751370A — Refresh a changing MCP tool catalog

Given an active MCP server changes its tool catalog
	When the negotiated protocol announces a tool-list change
		Or the advertised tool-catalog cache lifetime expires
		Or integral provisions a new Pi session after reconnecting
		Then integral retrieves the complete current catalog
			And validates it before replacing the previous catalog
			And makes the replacement catalog visible no later than the next Pi turn
			And lets an invocation already in flight finish against its original catalog
			And removes tools no longer advertised
			And adds newly advertised tools without requiring the user to remove and re-add the connection
	When catalog refresh fails
		Then integral retains no newly received partial catalog
			And reports the connection as degraded
			And does not prevent unrelated connections from operating

## MCP-6F5CFA0E — Isolate MCP connection failures

Given multiple MCP connections are configured
	When one server is unreachable, unauthorized, malformed, protocol-incompatible, or its stdio process exits
		Then integral marks only that connection unavailable or degraded
			And identifies the failing stage in `integral connection ls`
			And keeps its credentials secret
			And continues provisioning tools from healthy connections
	When the failing server later passes authorization, negotiation, and tool discovery
		Then integral returns the connection to active
			And makes its tools available no later than the next Pi turn
			And does not require the connection to be recreated

## MCP-0A804DA4 — Isolate and supervise a stdio MCP server

Given an active stdio MCP connection is available to a Pi session
	When the runner provisions that session
		Then integral starts one dedicated MCP sidecar from the configured runner image
			And runs it as the same non-root numeric user used for Pi
			And gives it a read-only root filesystem, bounded temporary storage, bounded memory, no Linux capabilities, and no privilege escalation
			And does not mount the Pi session home, repositories, stores, Docker socket, Integral control-plane files, or host paths into it
			And supplies only its declared non-secret environment and assigned secret environment values
			And delivers secret values after sidecar creation without placing them in image configuration, container arguments, or persistent Docker metadata
			And keeps its network disconnected except for explicitly declared URL boundaries through the authenticated gateway
			And brokers MCP messages between Pi and the sidecar without exposing the sidecar's standard streams directly to Pi
			And negotiates the newest mutually supported version from the same MCP versions supported for remote servers
			And treats newline-delimited standard output as MCP protocol messages
			And treats standard error as bounded diagnostic output with credential redaction
	When the sidecar writes non-protocol data to standard output
		Then integral marks that connection unavailable for the session
			And terminates the sidecar without interpreting the data as a tool result
	When the sidecar exits, hangs, exceeds a resource limit, or violates its network policy
		Then integral fails the affected invocation with a bounded connection error
			And terminates any remaining sidecar resources
			And leaves Pi and unrelated MCP connections running
	When the Pi session ends or is replaced
		Then integral closes the sidecar's standard input
			And allows a bounded graceful-exit period
			And forcibly terminates the sidecar if it remains running
			And removes all sidecar resources and secret material
