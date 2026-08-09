# Connection behaviors

These behaviors preserve the source project's connection CLI ergonomics for a
single user. Connections may describe model providers, email accounts, generic
HTTP endpoints, remote or stdio MCP servers, governed host Git repositories, or durable
writable host stores. Every active connection is available to Pi; integral has
no grant or revoke concept.

<!-- Automation note (CONNECTION-03C4E791): Guided setup validation and its explicit equivalent are automated; keystroke-level interactive selection is not driven by the non-interactive default suite. -->
<!-- Automation note (CONNECTION-1D691391): Commit-after-verification behavior is automated with a controlled failing endpoint; no real provider is contacted. -->
<!-- Automation note (CONNECTION-741C2F56): The two independent removal decisions and storage outcomes are automated below the PTY prompt layer; prompt keystrokes are an acceptance test. -->
<!-- Automation note (CONNECTION-E73B40C6): No-auth removal outcomes are automated below the PTY prompt layer; prompt keystrokes are an acceptance test. -->
<!-- Automation note (CONNECTION-89A88F7C): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (CONNECTION-06B6AE14): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (CONNECTION-857967F4): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (CONNECTION-C0978F5E): This behavior defines planned host-resource source-validation functionality; executable coverage will land with implementation. -->
<!-- Automation note (CONNECTION-717CAD0E): This behavior defines planned host-resource availability functionality; executable coverage will land with implementation. -->

## CONNECTION-C14B8E70 — Show connection command help

Given integral is installed
	When the user runs `integral connection --help`
		Then the command lists `catalog`, `add`, `ls`, and `rm`
			And describes bare `add` as guided setup
			And documents `--auth` for explicit setup
			And documents `--transport`, `--command`, `--arg`, `--env`, `--secret-env`, and `--allow-url` for MCP setup
			And documents `--path`, `--branch`, and `--mount` for host resources
			And does not list `grant` or `revoke`

## CONNECTION-75EC27E8 — Show the connection catalog

Given integral is installed
	When the user runs `integral connection catalog`
		Then the command lists `openai-codex` and `anthropic`
			And lists `gmail` and `mailgun` email providers
			And lists generic `http` and `mcp` connection types
			And lists the `host-repo` connection type
			And lists the `host-store` connection type
			And identifies the kind of each catalog entry
			And describes supported OAuth, device-code, key, and no-auth methods
			And does not list channel or general host-directory connection types

## CONNECTION-03C4E791 — Open guided connection setup

Given an interactive terminal
	When the user runs `integral connection add`
		Then integral presents the connection catalog
			And lets the user select a provider or generic connection type
			And lets the user name the connection
			And lets the user select an authentication method when required
			And collects the endpoint and protocol details required by the type
			And normally asks only for a name and URL when the selected type is remote MCP
			And collects a command and arguments when the selected type is stdio MCP
			And treats MCP authentication and transport choices as advanced compatibility overrides
			And requires a mount path for a host resource
			And runs the selected authentication flow
			And completes the same setup as explicit `connection add <entry>`

## CONNECTION-46E90D69 — Add a model connection explicitly

Given no connection exists for the selected provider
	When the user runs `integral connection add <provider>`
		And provider authentication succeeds
		Then integral stores the credential in the host control-plane area
			And creates a model connection named after the provider
			And makes the credential file readable only by its owner
			And makes the connection available to new chat sessions
			And identifies the connection without printing secret values

## CONNECTION-2F7C9A61 — Choose a supported authentication method

Given the selected catalog entry supports more than one authentication method
	And the selected entry is not MCP
	When the user runs `integral connection add <entry>` without `--auth`
		Then integral lists the authentication methods supported by that entry
			And asks the user to choose one before starting authentication
			And does not assume an authentication method
	When standard input is not an interactive terminal
		Then integral requires `--auth`
			And identifies the supported values
	When the user supplies a supported method with `--auth <method>`
		Then integral uses that authentication method without asking
Given the selected catalog entry is MCP with a remote URL
	When the user adds it without `--auth`
		Then integral probes whether the server permits anonymous MCP access
			And follows standardized MCP authorization discovery when authentication is required
			And does not ask the user to choose an authentication family
Given the selected catalog entry supports exactly one authentication method
	When the user runs `integral connection add <entry>` without `--auth`
		Then integral selects that method without an echoed authentication prompt
			And begins its authentication flow directly

## CONNECTION-512D9A25 — Select an authentication method explicitly

Given the selected connection type supports the requested authentication method
	When the user adds it with `--auth oauth`
		Then integral runs the configured OAuth authorization flow
	When the user adds it with `--auth device-code`
		Then integral runs the configured device authorization flow
			And displays the verification URL and user code
			And polls until authorization succeeds, fails, or expires
	When the user adds it with `--auth key`
		Then integral reads the key without echoing it
			And stores it in the host credential area
	When the user adds it with `--auth key --credential-stdin`
		Then integral reads one non-empty credential from standard input
			And does not require an interactive terminal
	When the user adds it with `--auth none`
		Then integral creates the connection without requesting or storing a credential
	When the user requests an authentication method unsupported by the entry
		Then integral rejects setup without creating a connection
	When an OAuth access token is within one minute of expiry
		Then the gateway refreshes it before using the connection
			And atomically stores the refreshed OAuth record
	When an expired OAuth credential cannot be refreshed
		Then the gateway excludes its credential from request injection
			And publishes degraded gateway health with the refresh error

## CONNECTION-6D2A9F84 — Complete OAuth without opening a local browser

Given the selected connection uses OAuth
	And a browser cannot be opened locally
	When the user runs `integral connection add`
		Then integral prints the authorization URL in the terminal
			And accepts a matching loopback callback when one is available
			And accepts a pasted authorization code or full redirect URL
			And validates the redirect state when one is present
			And uses PKCE for generic authorization-code exchange
			And times out generic authorization after ten minutes
			And completes the same credential storage as a local callback

## CONNECTION-1D691391 — Verify a connection during setup

Given the selected catalog entry supports credential verification
	When the user runs `integral connection add <entry> --verify`
		And authentication succeeds
		Then integral makes one authenticated `HEAD` request through trusted host code
			And completes setup only when verification succeeds
			And reports verification failure without printing secret values

## CONNECTION-634C2DA7 — Rotate existing connection credentials

Given a connection with one or more stored credentials already exists
	When the user adds the same entry and connection name again
		And authentication or stdio secret collection succeeds
		Then integral replaces the stored credentials atomically
			And preserves the connection's name and non-secret configuration
			And requires the kind, provider, authentication method, and declared stdio secret names to match
			And new model or stdio requests use the replacement credentials
			And advances the connection generation
			And the command reports rotation rather than duplicate creation
	When the existing connection uses no authentication and declares no secret environment values
		Then integral refuses to treat another add as credential rotation

## CONNECTION-5833EDC7 — List connections

Given zero or more connections have been configured
	When the user runs `integral connection ls`
		Then integral lists every connection by name
			And shows its provider or generic type
			And shows its authentication method
			And shows `active` when its credential is usable
			And shows `active` for a valid no-auth connection
			And treats OAuth as usable when its access token is unexpired or it has a refresh token
			And shows `DISABLED (no secret)` when a credentialed connection has no credential
			And shows `DISABLED (no secret)` when a stdio connection is missing any declared secret environment value
			And shows `DISABLED (no secret)` for malformed or expired OAuth without a refresh token
			And does not print secret values

## CONNECTION-475E6AE7 — List connections as JSON

Given zero or more connections have been configured
	When the user runs `integral connection ls --json`
		Then integral writes a machine-readable JSON array to stdout
			And represents the same names, types, auth methods, and states as the human view
			And does not include secret values

## CONNECTION-741C2F56 — Remove a connection deliberately

Given a connection with one or more stored credentials exists
	And the terminal is interactive
	When the user runs `integral connection rm <name>`
		Then integral describes the credentials and connection record to be removed without printing secret values
			And asks for confirmation before removing the credentials
	When the user declines credential removal
		Then integral leaves the credentials and connection unchanged
	When the user confirms credential removal
		Then integral removes every credential owned by the connection
			And asks separately whether to remove the connection record
	When the user declines connection-record removal
		Then integral retains the connection record
			And `connection ls` shows it as `DISABLED (no secret)`
	When the user confirms connection-record removal
		Then integral removes the connection record
			And prevents new chats from selecting the removed connection

## CONNECTION-20778353 — Refuse server startup without an active model connection

Given no active model connection is configured
	When the user runs `integral server start`
		Then the server exits non-zero
			And does not accept chat sessions
			And instructs the user to run `integral connection add`
			And does not start a container
	When the user starts only the runner component
		Then the runner exits non-zero with the same connection instruction
	When the user starts only the coordinator or gateway component
		Then that component is not refused solely because the model connection is absent

## CONNECTION-0FB2F92A — Keep real credentials outside the container

Given an active credentialed connection is configured on the host
	When integral provisions a chat container
		Then every real credential is absent from the container environment
			And is absent from container files
			And is absent from container arguments
			And is absent from Docker metadata
			And any credential visible to Pi is a harmless sentinel

## CONNECTION-9C7A41E2 — Name a connection explicitly

Given the user wants to choose a connection name
	When the user runs `integral connection add <entry> --name <name>`
		And the selected authentication setup succeeds
		Then integral stores the connection and any credential under the requested name
			And reports the provider or type separately from the connection name
			And lets later `connection ls` and `connection rm` address that name

## CONNECTION-A61E2C9D — Add a generic HTTP connection

Given the user has an HTTP or HTTPS endpoint
	When the user runs `integral connection add http --name <name> --url <url>`
		And completes the selected authentication setup
		Then integral records the normalized scheme, host, port, and path prefix
			And makes the named endpoint available to Pi
			And configures the gateway to allow only that endpoint boundary
			And injects its credential only inside that boundary when authentication requires it

## CONNECTION-4B8D73F1 — Add a remote MCP connection

Given the user has the URL of a remote MCP server
	When the user runs `integral connection add mcp --name <name> --url <url>`
		Then integral contacts the endpoint through trusted host code
			And automatically detects Streamable HTTP or legacy HTTP+SSE
			And determines whether the endpoint requires authentication
			And completes standardized MCP OAuth when authentication is required
			And completes without authentication when the server permits anonymous access
			And negotiates a supported MCP protocol version
			And discovers every available tool before committing the connection
			And stores the connection only after discovery succeeds
			And reports the server name, negotiated protocol, transport, authentication state, and tool count
			And does not require transport, OAuth endpoint, scope, or client-registration flags for a conforming MCP server
	When discovery, authentication, protocol negotiation, or tool discovery fails
		Then integral exits non-zero
			And explains the failing stage without printing credentials
			And does not store a partial connection or credential
	When the user explicitly supplies supported authentication or transport options
		Then integral treats them as compatibility overrides
			And still verifies the resulting MCP connection before committing it

<!-- Automation note (CONNECTION-0EF2CF89): This behavior defines planned stdio MCP setup; executable coverage will land with implementation. -->

## CONNECTION-0EF2CF89 — Add a stdio MCP connection

Given the user has an MCP server executable available in the configured runner image
	When the user runs `integral connection add mcp --transport stdio --name <name> --command <executable>`
		And supplies zero or more `--arg <argument>` values
		Then integral records the executable and each argument without shell parsing or expansion
			And treats the argument following `--command` as the exact executable name or absolute image path
			And uses the arguments in their supplied order
			And runs setup verification in a short-lived isolated sidecar using the configured runner image
			And negotiates a supported MCP protocol over standard input and standard output
			And discovers every available tool before committing the connection
			And stores the connection only after discovery succeeds
			And reports the server name, stdio transport, protocol, and tool count
	When the user supplies `--env <name>=<value>`
		Then integral stores and supplies the value as non-secret sidecar configuration
	When the user supplies `--secret-env <name>`
		Then integral reads the named value without echoing it
			And stores it only in the host credential area
			And supplies it only to that MCP sidecar process
			And never exposes it to Pi, tool declarations, logs, or connection listings
	When the user supplies one or more `--allow-url <url>` values
		Then integral gives the sidecar outbound access only within those normalized URL boundaries
			And does not inject another connection's credential into those requests
	When no `--allow-url` is supplied
		Then the sidecar has no external network access
	When the executable cannot start, emits invalid protocol data, exits during verification, or does not expose a valid tool catalog
		Then integral exits non-zero
			And removes the verification sidecar
			And does not store a partial connection or secret

## CONNECTION-D20F6A85 — Make active connections available automatically

Given a connection is valid and active
	When integral starts a new Pi session
		Then integral makes the connection available to that session automatically
			And maps Anthropic model traffic to `https://api.anthropic.com/`
			And maps OpenAI Codex model traffic to `https://chatgpt.com/backend-api/`
			And injects the stored OpenAI account ID as `chatgpt-account-id` when present
			And does not expose another connection's credential on its requests

## CONNECTION-12C87631 — Connect GitHub without exposing its token

Given no GitHub connection exists
	When the user runs `integral connection add github --auth key`
		And supplies a non-empty personal access token
		Then integral stores one connection for `api.github.com` and `github.com`
			And stores the token only in the host credential area
			And identifies GitHub as an HTTP connection in the catalog and connection list
Given an active GitHub connection exists
	And a Pi session provisioned before that connection is still active
	When integral observes the new connection generation
		Then integral ends the stale Pi session before the next turn
			And provisions the replacement with GitHub access
Given an active GitHub connection exists
	When integral provisions a Pi container
		Then the container includes `git` and `gh`
			And receives `GH_TOKEN` set to the integral credential sentinel
			And does not receive the real GitHub token
	When Pi calls the GitHub API over HTTPS
		Then the gateway allows the request only on `api.github.com`
			And injects the stored token using GitHub API authentication
	When Pi uses Git smart HTTP over HTTPS
		Then the gateway allows the request only on `github.com`
			And injects the stored token using GitHub Basic authentication
	When Pi attempts GitHub access through SSH or another host
		Then the gateway denies the request

## CONNECTION-8F14C3B7 — Reject an invalid generic connection declaration

Given the user is adding a generic HTTP or remote MCP connection
	When its name is missing or already used
		Then integral rejects setup without changing stored connections
	When its URL is missing, malformed, or uses an unsupported scheme
		Then integral rejects setup without changing stored connections
	When explicitly configured authentication metadata is incomplete
		Then integral rejects setup without storing partial credentials

## CONNECTION-E73B40C6 — Remove a no-auth connection deliberately

Given a no-auth HTTP or MCP connection with no stored secret environment values exists
	And the terminal is interactive
	When the user runs `integral connection rm <name>`
		Then integral describes the connection record to be removed
			And asks for confirmation before removing it
	When the user declines confirmation
		Then integral leaves the connection unchanged
	When the user confirms removal
		Then integral removes the connection record
			And prevents new chats from selecting the removed connection

## CONNECTION-89A88F7C — Add and attach an existing host repository

Given an existing bare Git repository is available at a host path
	When the user runs `integral connection add host-repo --name <name> --path <path> [--branch <branch>] --mount <container-path>`
		Then integral accepts an absolute host path or resolves a relative host path from the current directory
			And accepts an absolute container path or resolves a relative container path below `/home/pi`
			And canonicalizes the host path
			And validates that it is a bare Git repository readable and writable by the Integral host process
			And selects `--branch <branch>` when supplied
			And otherwise selects the repository's symbolic `HEAD` branch
			And uses `main` for an empty repository whose symbolic `HEAD` is unborn
			And stores a governed repository connection without a credential
			And does not copy, move, modify, or change ownership of the repository during setup
			And records the canonical path and filesystem identity of its backing root
			And validates and records the requested mount path in the same atomic operation
			And marks every live Pi session stale so the checkout appears before its next prompt
			And advances the connection generation
	When the path or mount is missing, invalid, already connected, or the repository has no selectable branch
		Then integral rejects setup without creating a connection or modifying the path
			And explains how to create a bare clone when the source is a working checkout

## CONNECTION-857967F4 — Add and attach an existing durable host store

Given an existing host directory is available at a host path
	When the user runs `integral connection add host-store --name <name> --path <path> --mount <container-path>`
		Then integral accepts an absolute host path or resolves a relative host path from the current directory
			And accepts an absolute container path or resolves a relative container path below `/home/pi`
			And canonicalizes the host path
			And validates that it is a directory readable and writable by the Integral host process
			And stores a host-store connection without a credential
			And does not copy, move, modify, snapshot, or change ownership of the directory during setup
			And records the canonical path and filesystem identity of its backing root
			And validates and records the requested mount path in the same atomic operation
			And marks every live Pi session stale so the store is mounted before its next prompt
			And advances the connection generation
	When the path or mount is missing, invalid, already connected, or lacks required access
		Then integral rejects setup without creating a connection or modifying the path

## CONNECTION-C0978F5E — Validate host-resource source paths

Given the connection CLI is adding an existing host repository or store
	When integral validates its source path
		Then it resolves symbolic links and records one canonical absolute host path
			And rejects the filesystem root
			And rejects an Integral deployment root, control-plane directory, credential directory, or any of their ancestors
			And rejects a path equal to, above, or below another configured host resource
			And rejects a socket, device, named pipe, or other source of the wrong filesystem type
			And performs all validation in trusted host code
			And never makes the source path available to Pi

## CONNECTION-717CAD0E — Detect and recover host-resource availability

Given a host-repository or host-store connection records a canonical path and backing filesystem identity
	When the periodic health check, session provisioner, or a host-mediated resource operation validates it
		Then integral distinguishes `missing`, `wrong_type`, `permission_denied`, `identity_changed`, `invalid_repository`, and `read_only` where applicable
			And marks an active failing resource unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation exactly once when it transitions from active
			And does not terminate or replace an existing Pi session
			And never recreates missing backing data
	When an unavailable resource reappears with the same filesystem identity and passes validation
		Then integral returns it to active for sessions started afterward
			And advances its lifecycle revision and the connection generation
			And does not alter any existing session
	When a different backing identity appears at the recorded path
		Then integral leaves the resource unavailable
			And never silently adopts the replacement
			And requires the operator to soft-delete the unavailable resource and add the replacement as a new governed resource
	When the operator tries to add a replacement path still referenced by an existing session
		Then integral rejects the addition until every session using the prior backing identity ends naturally

## CONNECTION-06B6AE14 — List and remove host-resource connections safely

Given a host-repository or host-store connection exists
	When the user runs `integral connection ls`
		Then integral identifies it as `host-repo` or `host-store`
			And reports whether it is active, unavailable, or soft-deleted
			And reports a bounded availability reason and whether restoration is currently possible
			And reports its Pi mount path
			And does not print its canonical host path unless the user requests JSON output
	When the user runs `integral connection rm <name>` in an interactive terminal
		Then integral identifies the resource kind
			And displays the lifecycle revision to be removed
			And asks for confirmation
	When the user confirms removal
		And the displayed lifecycle revision remains current
		Then integral performs the same soft deletion as the matching Pi resource tool
			And does not terminate or replace an existing Pi session
			And reports that existing sessions retain their checkout or mount until they end naturally
			And never permanently deletes canonical repository or store content
	When the lifecycle revision changes while confirmation is pending
		Then integral rejects the stale confirmation without changing the connection
