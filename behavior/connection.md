# Connection behaviors

These behaviors preserve the source project's connection CLI ergonomics for a
single user. Connections may describe model providers, generic HTTP endpoints,
or remote MCP servers. Every active connection is available to Pi; rr has no
grant or revoke concept.

<!-- Automation note (CONNECTION-03C4E791): Guided setup validation and its explicit equivalent are automated; keystroke-level interactive selection is not driven by the non-interactive default suite. -->
<!-- Automation note (CONNECTION-1D691391): Commit-after-verification behavior is automated with a controlled failing endpoint; no real provider is contacted. -->
<!-- Automation note (CONNECTION-741C2F56): The two independent removal decisions and storage outcomes are automated below the PTY prompt layer; prompt keystrokes are an acceptance test. -->
<!-- Automation note (CONNECTION-E73B40C6): No-auth removal outcomes are automated below the PTY prompt layer; prompt keystrokes are an acceptance test. -->

## CONNECTION-C14B8E70 — Show connection command help

Given rr is installed
	When the user runs `rr connection --help`
		Then the command lists `catalog`, `add`, `ls`, and `rm`
			And describes bare `add` as guided setup
			And documents `--auth` for explicit setup
			And does not list `grant` or `revoke`

## CONNECTION-75EC27E8 — Show the connection catalog

Given rr is installed
	When the user runs `rr connection catalog`
		Then the command lists `openai-codex` and `anthropic`
			And lists generic `http` and `mcp` connection types
			And identifies the kind of each catalog entry
			And describes supported OAuth, device-code, key, and no-auth methods
			And does not list channel or host-resource connection types

## CONNECTION-03C4E791 — Open guided connection setup

Given an interactive terminal
	When the user runs `rr connection add`
		Then rr presents the connection catalog
			And lets the user select a provider or generic connection type
			And lets the user name the connection
			And lets the user select an authentication method when required
			And collects the endpoint and protocol details required by the type
			And runs the selected authentication flow
			And completes the same setup as explicit `connection add <entry>`

## CONNECTION-46E90D69 — Add a model connection explicitly

Given no connection exists for the selected provider
	When the user runs `rr connection add <provider>`
		And provider authentication succeeds
		Then rr stores the credential in the host control-plane area
			And creates a model connection named after the provider
			And makes the credential file readable only by its owner
			And makes the connection available to new chat sessions
			And identifies the connection without printing secret values

## CONNECTION-2F7C9A61 — Choose a supported authentication method

Given the selected catalog entry supports one or more authentication methods
	When the user runs `rr connection add <entry>` without `--auth`
		Then rr lists the authentication methods supported by that entry
			And asks the user to choose one before starting authentication
			And does not assume an authentication method
	When standard input is not an interactive terminal
		Then rr requires `--auth`
			And identifies the supported values
	When the user supplies a supported method with `--auth <method>`
		Then rr uses that authentication method without asking

## CONNECTION-512D9A25 — Select an authentication method explicitly

Given the selected connection type supports the requested authentication method
	When the user adds it with `--auth oauth`
		Then rr runs the configured OAuth authorization flow
	When the user adds it with `--auth device-code`
		Then rr runs the configured device authorization flow
			And displays the verification URL and user code
			And polls until authorization succeeds, fails, or expires
	When the user adds it with `--auth key`
		Then rr reads the key without echoing it
			And stores it in the host credential area
	When the user adds it with `--auth key --credential-stdin`
		Then rr reads one non-empty credential from standard input
			And does not require an interactive terminal
	When the user adds it with `--auth none`
		Then rr creates the connection without requesting or storing a credential
	When the user requests an authentication method unsupported by the entry
		Then rr rejects setup without creating a connection
	When an OAuth access token is within one minute of expiry
		Then the gateway refreshes it before using the connection
			And atomically stores the refreshed OAuth record
	When an expired OAuth credential cannot be refreshed
		Then the gateway excludes its credential from request injection
			And publishes degraded gateway health with the refresh error

## CONNECTION-6D2A9F84 — Complete OAuth without opening a local browser

Given the selected connection uses OAuth
	And a browser cannot be opened locally
	When the user runs `rr connection add`
		Then rr prints the authorization URL in the terminal
			And accepts a matching loopback callback when one is available
			And accepts a pasted authorization code or full redirect URL
			And validates the redirect state when one is present
			And uses PKCE for generic authorization-code exchange
			And times out generic authorization after ten minutes
			And completes the same credential storage as a local callback

## CONNECTION-1D691391 — Verify a connection during setup

Given the selected catalog entry supports credential verification
	When the user runs `rr connection add <entry> --verify`
		And authentication succeeds
		Then rr makes one authenticated `HEAD` request through trusted host code
			And completes setup only when verification succeeds
			And reports verification failure without printing secret values

## CONNECTION-634C2DA7 — Rotate an existing connection credential

Given a credentialed connection already exists
	When the user adds the same entry and connection name again
		And authentication succeeds
		Then rr replaces the stored credential atomically
			And preserves the connection's name and non-secret configuration
			And requires the kind, provider, and authentication method to match
			And new model requests use the replacement credential
			And advances the connection generation
			And the command reports rotation rather than duplicate creation
	When the existing connection uses no authentication
		Then rr refuses to treat another add as credential rotation

## CONNECTION-5833EDC7 — List connections

Given zero or more connections have been configured
	When the user runs `rr connection ls`
		Then rr lists every connection by name
			And shows its provider or generic type
			And shows its authentication method
			And shows `active` when its credential is usable
			And shows `active` for a valid no-auth connection
			And treats OAuth as usable when its access token is unexpired or it has a refresh token
			And shows `DISABLED (no secret)` when a credentialed connection has no credential
			And shows `DISABLED (no secret)` for malformed or expired OAuth without a refresh token
			And does not print secret values

## CONNECTION-475E6AE7 — List connections as JSON

Given zero or more connections have been configured
	When the user runs `rr connection ls --json`
		Then rr writes a machine-readable JSON array to stdout
			And represents the same names, types, auth methods, and states as the human view
			And does not include secret values

## CONNECTION-741C2F56 — Remove a connection deliberately

Given a credentialed connection exists
	And the terminal is interactive
	When the user runs `rr connection rm <name>`
		Then rr describes the credential and connection record to be removed
			And asks for confirmation before removing the credential
	When the user declines credential removal
		Then rr leaves the credential and connection unchanged
	When the user confirms credential removal
		Then rr removes the credential
			And asks separately whether to remove the connection record
	When the user declines connection-record removal
		Then rr retains the connection record
			And `connection ls` shows it as `DISABLED (no secret)`
	When the user confirms connection-record removal
		Then rr removes the connection record
			And prevents new chats from selecting the removed connection

## CONNECTION-20778353 — Refuse server startup without an active model connection

Given no active model connection is configured
	When the user runs `rr server start`
		Then the server exits non-zero
			And does not accept chat sessions
			And instructs the user to run `rr connection add`
			And does not start a container
	When the user starts only the runner component
		Then the runner exits non-zero with the same connection instruction
	When the user starts only the coordinator or gateway component
		Then that component is not refused solely because the model connection is absent

## CONNECTION-0FB2F92A — Keep real credentials outside the container

Given an active credentialed connection is configured on the host
	When rr provisions a chat container
		Then every real credential is absent from the container environment
			And is absent from container files
			And is absent from container arguments
			And is absent from Docker metadata
			And any credential visible to Pi is a harmless sentinel

## CONNECTION-9C7A41E2 — Name a connection explicitly

Given the user wants to choose a connection name
	When the user runs `rr connection add <entry> --name <name>`
		And the selected authentication setup succeeds
		Then rr stores the connection and any credential under the requested name
			And reports the provider or type separately from the connection name
			And lets later `connection ls` and `connection rm` address that name

## CONNECTION-A61E2C9D — Add a generic HTTP connection

Given the user has an HTTP or HTTPS endpoint
	When the user runs `rr connection add http --name <name> --url <url>`
		And completes the selected authentication setup
		Then rr records the normalized scheme, host, port, and path prefix
			And makes the named endpoint available to Pi
			And configures the gateway to allow only that endpoint boundary
			And injects its credential only inside that boundary when authentication requires it

## CONNECTION-4B8D73F1 — Add a remote MCP connection

Given the user has a remote MCP server endpoint
	When the user runs `rr connection add mcp --name <name> --url <url>`
		And completes the selected authentication setup
		Then rr records the remote MCP transport and endpoint
			And registers the named MCP server with Pi for new sessions
			And supports streamable HTTP and legacy SSE request flows
			And places only sentinel authentication in the generated Pi extension
			And configures the gateway to allow only that endpoint boundary
			And injects its credential only inside that boundary when authentication requires it

## CONNECTION-D20F6A85 — Make active connections available automatically

Given a connection is valid and active
	When rr starts a new Pi session
		Then rr makes the connection available to that session automatically
			And maps Anthropic model traffic to `https://api.anthropic.com/`
			And maps OpenAI Codex model traffic to `https://chatgpt.com/backend-api/`
			And injects the stored OpenAI account ID as `chatgpt-account-id` when present
			And does not expose another connection's credential on its requests

## CONNECTION-8F14C3B7 — Reject an invalid generic connection declaration

Given the user is adding a generic HTTP or MCP connection
	When its name is missing or already used
		Then rr rejects setup without changing stored connections
	When its URL is missing, malformed, or uses an unsupported scheme
		Then rr rejects setup without changing stored connections
	When required authentication metadata is incomplete
		Then rr rejects setup without storing partial credentials

## CONNECTION-E73B40C6 — Remove a no-auth connection deliberately

Given a no-auth connection exists
	And the terminal is interactive
	When the user runs `rr connection rm <name>`
		Then rr describes the connection record to be removed
			And asks for confirmation before removing it
	When the user declines confirmation
		Then rr leaves the connection unchanged
	When the user confirms removal
		Then rr removes the connection record
			And prevents new chats from selecting the removed connection
