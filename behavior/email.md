# Email behaviors

These behaviors cover first-class email accounts. Email operations run through
trusted host code; the Pi container receives semantic tools and never receives
the account credential.

## EMAIL-B765A312 — Configure provider-defined email capabilities

Given the connection catalog contains Gmail and Mailgun email providers
	When the user configures a Gmail email connection
		Then the connection may enable `read`, `search`, and `send`
			And uses OAuth with the scopes required by its enabled capabilities
			And requires the authenticated account address and OAuth client ID
	When the user configures a Mailgun email connection
		Then the connection enables only `send`
			And requires a sending domain, fixed From address, region, and API key
	When the user interactively adds Gmail or Mailgun without required email options
		Then integral prompts for the missing non-secret account and policy options
			And requests the credential only after those options are valid
	When an email connection enables `send`
		Then it requires at least one exact-address or domain-wildcard allowed recipient policy
			And an omitted policy or catch-all wildcard never means allow all recipients
	When an email connection requests a capability unsupported by its provider
		Then integral rejects the declaration without storing credentials

## EMAIL-276B27AA — Search and read Gmail through the host boundary

Given an active Gmail connection enables `search` or `read`
	When Pi searches the account with a Gmail query
		Then trusted host code returns a bounded list of matching message summaries
			And does not modify mailbox state
	When Pi reads a message by its Gmail message ID
		Then trusted host code returns its headers and bounded text content
			And does not modify mailbox state
	When Pi requests a read or search operation that the connection did not enable
		Then the host refuses the operation without contacting Gmail

## EMAIL-19BA105D — Send email through a constrained account

Given an active Gmail or Mailgun connection enables `send`
	When Pi submits a text email whose recipients match that connection's policy
		Then trusted host code fixes the From identity to the configured account
			And sends through the configured provider API
			And returns the provider's message identity
	When any To, Cc, or Bcc recipient is outside the connection's policy
		Then the host refuses the entire message without contacting the provider
	When a message contains an invalid address, header injection, or exceeds a bounded field limit
		Then the host refuses the entire message without contacting the provider

## EMAIL-89334867 — Expose only semantic email tools to Pi

Given one or more active email connections exist when a Pi session starts
	When the runner prepares the session home
		Then it registers tools only for capabilities enabled by those connections
			And each tool calls the authenticated host email boundary
			And no real email credential is written to the session home
	When no active email connection exists
		Then the runner does not install the email extension
