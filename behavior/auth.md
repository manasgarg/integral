# Authentication behaviors

These behaviors cover the model credential retained by the trusted host.

## AUTH-001 — Configure a model credential

Given no model credential is configured
	When the user runs `rr auth login --provider <provider>`
		And provider authentication succeeds
		Then rr stores the credential in the host control-plane area
			And makes the credential file readable only by its owner
			And identifies the configured provider without printing secret values

## AUTH-002 — Select a supported provider

Given Phase 1 supports the `openai-codex` provider adapter
	And Phase 1 supports the `anthropic` provider adapter
	When the user logs in with either supported provider
		Then rr uses the selected provider's authentication flow
			And makes that provider the only provider used by new chat sessions

## AUTH-003 — Inspect authentication state

Given a model provider may or may not be configured
	When the user runs `rr auth status`
		Then rr reports the selected provider
			And reports whether its credential is usable
			And does not make a model request
			And does not print secret values

## AUTH-004 — Refuse server startup without a usable credential

Given no usable model credential is configured
	When the user runs `rr server start`
		Then the server exits non-zero
			And does not accept chat sessions
			And instructs the user to run `rr auth login`
			And does not start a container

## AUTH-005 — Keep the real credential outside the container

Given a model credential is configured on the host
	When rr provisions a chat container
		Then the real credential is absent from the container environment
			And is absent from container files
			And is absent from container arguments
			And is absent from Docker metadata
			And any provider credential visible to Pi is a harmless sentinel
