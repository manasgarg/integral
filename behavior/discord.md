# Discord DM behaviors

These behaviors cover a single trusted Discord direct-message channel as a
host-side view onto Integral's one durable conversation. Discord is transport
and presentation only: it does not create another conversation, grant the agent
Discord capabilities, or weaken governed-operation approvals.

<!-- Automation note (DISCORD-E4BE44A7): This behavior defines planned Discord connection setup; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-E043BBDD): This behavior defines planned Discord listener lifecycle; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-E5BF908E): This behavior defines the planned single-DM authorization boundary; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-A3CB29FC): This behavior defines planned Discord conversation ingress and recovery; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-5D67C2B9): This behavior defines planned Discord response presentation; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-89FAF039): This behavior defines planned Discord slash-command behavior; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-D235BC26): This behavior defines planned Discord status and failure isolation; executable coverage will land with implementation. -->

## DISCORD-E4BE44A7 — Configure exactly one Discord DM

Given no Discord connection exists for the deployment
	When the user runs `integral connection add discord` in an interactive terminal
		Then Integral reads the bot token without echoing it
			And accepts the token from standard input when `--credential-stdin` is supplied
			And verifies the token by resolving the bot and application identities through Discord
			And offers the application owner as the DM user when that owner resolves to one Discord user
			And otherwise requires the user to enter the exact Discord user ID
			And requires the user to confirm the resolved Discord user identity
			And opens or resolves the direct-message channel for that bot and user
			And stores the bot token in an owner-readable credential file
			And stores the application, bot, user, and DM channel IDs as non-secret connection configuration
			And never prints the bot token
			And commits the credential and connection only after every verification step succeeds
	When the user supplies `--user-id <discord-user-id>`
		Then Integral resolves and confirms that exact user instead of selecting by username
	When token, identity, or DM-channel verification fails
		Then Integral exits non-zero without leaving a partial Discord connection or credential
Given a Discord connection already exists for the deployment
	When the user tries to add Discord for a different user or DM channel
		Then Integral rejects the second Discord connection
			And instructs the user to remove the existing connection before changing the bound DM
	When the user adds the same Discord application, user, and connection name with a valid replacement token
		Then Integral rotates the credential atomically without changing the bound DM identity

## DISCORD-E043BBDD — Run Discord as a supervised outbound listener

Given an active Discord connection is configured
	When the user runs `integral server start`
		Then Integral connects to Discord from the host using an outbound Gateway connection
			And does not expose a public HTTP endpoint for Discord
			And starts accepting Discord events only after the coordinator is ready
			And reconnects with bounded backoff after a transient Discord disconnect
	When Integral stops the server
		Then it stops accepting Discord events
			And closes the Discord Gateway connection before server shutdown completes
Given no active Discord connection is configured
	When the user runs `integral server start`
		Then Integral starts without a Discord listener
			And terminal conversation behavior remains available

## DISCORD-E5BF908E — Enforce the single-DM authorization boundary

Given Integral receives an event from Discord
	When the event belongs to the configured direct-message channel and bound user
		Then Integral may interpret the event according to the Discord behaviors
	When the event comes from a guild, another direct-message channel, another user, or a bot
		Then Integral ignores it before persisting conversation or command state
			And does not enqueue content, execute a command, or reveal conversation state
			And does not treat a matching username or display name as authorization
Given the bound Discord user uses the configured DM
	When Integral authorizes a message, command, or approval decision
		Then it revalidates both the immutable Discord user ID and channel ID
			And records those identities as the human origin
			And applies the same gateway and approval policy as a local terminal

## DISCORD-A3CB29FC — Submit Discord messages to the durable conversation

Given the configured Discord listener receives a non-empty text message from the bound user in the configured DM
	When Integral accepts the message
		Then it durably records the Discord message ID and provider, user, and channel origin before acknowledging durable acceptance
			And submits the text to the coordinator-owned queue for the one deployment conversation
			And preserves ordering with messages submitted from terminal clients
			And uses the conversation's selected model, context, session, and governed connections
			And broadcasts the persisted human message once to attached terminals with its Discord origin
			And does not make the Discord token or a Discord-send tool available to Pi
	When Discord redelivers a message whose Discord message ID is already recorded
		Then Integral does not add or process that message again
Given Discord messages arrived in the configured DM while Integral was disconnected
	When the listener reconnects or restarts
		Then Integral fetches messages after its durable ingress position
			And accepts eligible messages oldest first through the same durable path
			And advances recovery state only after each message is durably recorded for the conversation
			And neither loses nor intentionally duplicates an eligible message across a restart
Given the bound user sends an attachment, component interaction, reaction, or non-text message without a supported slash command
	When Integral receives the event
		Then Integral does not submit it to Pi
			And replies with a concise unsupported-content explanation when Discord permits a reply

## DISCORD-5D67C2B9 — Present Discord replies safely

Given Integral accepted a conversation message from the configured Discord DM
	When that message is queued or Pi is working on it
		Then Integral maintains Discord's typing indication until a response or terminal error is ready
	When Pi completes the corresponding response
		Then Integral sends the assistant text to the configured DM as host-side presentation
			And splits text into Unicode-safe Discord messages no longer than 2,000 characters
			And preserves the response order across all chunks
			And does not expose protocol events, raw JSON, credentials, or session tokens
	When the turn fails without assistant text
		Then Integral sends a concise user-facing error to the configured DM
			And stops the typing indication

## DISCORD-89FAF039 — Handle Discord commands on the host

Given the Discord connection becomes active
	When Integral registers commands for the configured application
		Then it makes `/help`, `/status`, `/model`, `/queue`, `/approvals`, `/approve`, and `/deny` available for direct-message use
			And does not register `/exit` because leaving a DM does not detach or end the conversation
Given the bound Discord user invokes a supported slash command in the configured DM
	When Integral handles the interaction
		Then it executes the equivalent host-side conversation command
			And `/model` reads or changes the one conversation's model selection
			And `/queue` lists, edits, or deletes messages using their stable queue IDs
			And `/approvals` lists unresolved governed requests without secret values
			And `/approve` and `/deny` use the governed approval lifecycle
			And it returns command output only to the bound user
			And it does not submit the command text to Pi
	When the user invokes `/help`
		Then Integral describes the supported Discord commands and their arguments

## DISCORD-D235BC26 — Isolate and report Discord failures

Given the core Integral server is healthy
	When Discord authentication, registration, connection, or delivery fails
		Then Integral keeps the coordinator, gateway, runner, terminal chat, and durable queue available
			And reports the Discord connection as degraded with a redacted failure reason
			And never includes the bot token in logs, status, command output, or conversation events
	When the bound Discord user invokes `/status`
		Then Integral reports the same conversation, model, queue, session, and component state available to terminal status
			And includes Discord listener health
			And identifies the configured bot, user, and DM without printing credentials
