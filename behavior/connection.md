# Connection behaviors

These behaviors preserve the source project's connection CLI ergonomics while
limiting Phase 1 connections to model providers.

## CONNECTION-C14B8E70 — Show connection command help

Given rr is installed
	When the user runs `rr connection --help`
		Then the command lists `catalog`, `add`, `ls`, and `rm`
			And describes bare `add` as guided setup
			And does not list `grant` or `revoke` in Phase 1

## CONNECTION-75EC27E8 — Show the model connection catalog

Given rr is installed
	When the user runs `rr connection catalog`
		Then the command lists `openai-codex` and `anthropic`
			And groups them under the `model` use
			And describes the authentication methods each provider supports
			And does not list capability, channel, or mount providers

## CONNECTION-03C4E791 — Open guided connection setup

Given an interactive terminal
	When the user runs `rr connection add`
		Then rr presents the model connection catalog
			And lets the user select a provider
			And lets the user select an authentication method when required
			And runs the selected provider's authentication flow
			And completes the same setup as explicit `connection add <provider>`

## CONNECTION-46E90D69 — Add a model connection explicitly

Given no connection exists for the selected provider
	When the user runs `rr connection add <provider>`
		And provider authentication succeeds
		Then rr stores the credential in the host control-plane area
			And creates a model connection named after the provider
			And makes the credential file readable only by its owner
			And makes the connection available to new chat sessions
			And identifies the connection without printing secret values

## CONNECTION-512D9A25 — Select an authentication method explicitly

Given the selected provider supports more than one authentication method
	When the user runs `rr connection add <provider> --auth <method>`
		Then rr uses the requested authentication flow
			And rejects a method not supported by that provider

## CONNECTION-1D691391 — Verify a connection during setup

Given the selected catalog provider supports credential verification
	When the user runs `rr connection add <provider> --verify`
		And provider authentication succeeds
		Then rr makes one authenticated verification request through trusted host code
			And completes setup only when verification succeeds
			And reports verification failure without printing secret values

## CONNECTION-634C2DA7 — Rotate an existing model credential

Given a model connection already exists for the selected provider
	When the user runs `rr connection add <provider>` again
		And provider authentication succeeds
		Then rr replaces the stored credential atomically
			And preserves the connection's name and non-secret configuration
			And new model requests use the replacement credential
			And the command reports rotation rather than duplicate creation

## CONNECTION-5833EDC7 — List model connections

Given zero or more model connections have been configured
	When the user runs `rr connection ls`
		Then rr lists every connection by name
			And shows its provider
			And shows its use as `model`
			And shows `active` when its credential is usable
			And shows `DISABLED (no secret)` when its credential is absent
			And does not print secret values

## CONNECTION-475E6AE7 — List model connections as JSON

Given zero or more model connections have been configured
	When the user runs `rr connection ls --json`
		Then rr writes a machine-readable JSON array to stdout
			And represents the same names, providers, uses, and states as the human view
			And does not include secret values

## CONNECTION-741C2F56 — Remove a model connection deliberately

Given a model connection exists
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

## CONNECTION-04D019E7 — Reject unsupported connection kinds

Given Phase 1 supports model connections only
	When the user tries to add a capability, channel, mount, or unknown provider
		Then rr exits non-zero
			And explains that the connection kind is outside Phase 1
			And does not create a credential or connection record

## CONNECTION-20778353 — Refuse server startup without an active model connection

Given no active model connection is configured
	When the user runs `rr server start`
		Then the server exits non-zero
			And does not accept chat sessions
			And instructs the user to run `rr connection add`
			And does not start a container

## CONNECTION-0FB2F92A — Keep the real credential outside the container

Given an active model connection is configured on the host
	When rr provisions a chat container
		Then the real credential is absent from the container environment
			And is absent from container files
			And is absent from container arguments
			And is absent from Docker metadata
			And any provider credential visible to Pi is a harmless sentinel

## CONNECTION-9C7A41E2 — Name a model connection explicitly

Given the user wants a connection name different from its provider name
	When the user runs `rr connection add <provider> --name <name>`
		And provider authentication succeeds
		Then rr stores the connection and credential under the requested name
			And reports the provider separately from the connection name
			And lets later `connection ls` and `connection rm` address that name
