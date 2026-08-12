# Discord DM behaviors

These behaviors cover one trusted Discord direct-message channel as its own
durable Integral conversation. The Discord DM and the default terminal
conversation keep separate histories, queues, model selections, sessions, and
task routes. In this release the logical Discord conversation maps one-to-one
to the configured native Discord DM; linking surfaces is out of scope. Discord
does not grant the agent credentials or weaken governed-operation approvals.

<!-- Automation note (DISCORD-E4BE44A7): This behavior defines planned Discord connection setup; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-E043BBDD): This behavior defines planned Discord listener lifecycle; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-E5BF908E): This behavior defines the planned single-DM authorization boundary; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-A3CB29FC): This behavior defines planned Discord conversation ingress and recovery; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-5D67C2B9): This behavior defines planned Discord response presentation; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-89FAF039): This behavior defines planned Discord slash-command behavior; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-D235BC26): This behavior defines planned Discord status and failure isolation; executable coverage will land with implementation. -->
<!-- Automation note (DISCORD-60D37149): This behavior defines planned origin-bound Discord task notifications; executable coverage will land with implementation. -->

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

## DISCORD-A3CB29FC — Submit Discord messages to their own conversation

Given the Discord listener receives a message in the configured DM
	And the sender is the bound Discord user
	And the message contains non-empty text
	And Integral has not imported its Discord message ID before
	When Integral imports the message
		Then the coordinator resolves the logical conversation from the Discord provider and configured DM channel ID
			And adds exactly one human message to that Discord conversation
			And stores the text together with the Discord message, user, and channel IDs
			And stamps the queued turn with the configured Discord DM as its host-controlled reply route
			And assigns its position in the Discord conversation's durable queue
			And does not add or broadcast the message to the default terminal conversation
			And Pi processes it with only the Discord conversation's history, selected model, session, and queue state
			And Pi may use the deployment's governed connections without gaining access to another conversation
			And Pi receives neither the Discord bot token nor a tool for sending Discord messages
Given Integral has already imported a Discord message ID
	When Discord delivers that message again
		Then Integral does not create another Discord conversation message or queue entry
			And does not run Pi again for that Discord message
Given eligible text messages arrived in the configured DM while the Discord listener was offline
	When the listener starts or reconnects
		Then Integral fetches every eligible message newer than its last durable Discord checkpoint
			And imports the fetched messages from oldest to newest
			And uses the Discord message ID to prevent a message from being imported twice
			And advances the checkpoint past a message only after that message is durably stored in the Discord conversation
			And retries an uncommitted message after a crash instead of skipping it
Given the bound user sends unsupported Discord content in the configured DM
	And the content is an attachment, reaction, or component interaction other than a supported slash command
	When Integral receives the content
		Then Integral does not add that content to the conversation or send it to Pi
			And replies once with a concise explanation that the content is unsupported
Given a Discord message contains both non-empty text and an unsupported attachment
	When Integral imports the message
		Then Integral adds only the text to the conversation
			And replies once that the attachment was not processed

## DISCORD-5D67C2B9 — Present Discord replies safely

Given Integral accepted a conversation message from the configured Discord DM
	When that message is queued or Pi is working on it
		Then Integral maintains Discord's typing indication until a response or terminal error is ready
	When Pi completes the corresponding response
		Then the coordinator records the assistant response only in the originating Discord conversation
			And Integral sends the assistant text only to the host-stamped Discord reply route for that turn
			And does not display the response in the default terminal conversation
			And splits text into Unicode-safe Discord messages no longer than 2,000 characters
			And preserves the response order across all chunks
			And does not expose protocol events, raw JSON, credentials, or session tokens
	When delivery to the originating Discord DM fails
		Then Integral reports the delivery failure without routing the response to a terminal or another channel
	When the turn fails without assistant text
		Then Integral sends a concise user-facing error only to the host-stamped Discord reply route
			And stops the typing indication

## DISCORD-60D37149 — Route task notifications to their channel of origin

Given a Pi turn originated from the configured Discord DM
	When the turn creates a durable task
		Then Integral stamps the task with the Discord logical conversation and native DM reply route from the trusted turn context
			And does not allow Pi or task content to choose or replace that route
			And sends the task filing receipt only to that Discord DM
			And records the receipt in that Discord conversation's history
Given a task carries a Discord origin route
	When Integral emits a task progress, approval, completion, or failure notification
		Then Integral sends the notification only to the stored Discord DM route
			And records a successfully delivered notification in the same Discord conversation's history
			And does not display the notification in the default terminal conversation or another channel
	When the Discord delivery fails
		Then Integral retains the task's original route
			And reports the delivery failure without falling back to a terminal or another channel
Given a task was created by the CLI, a schedule, or automation without a conversation origin
	When Integral emits a task notification
		Then Integral does not infer the configured Discord DM as its destination

## DISCORD-89FAF039 — Handle Discord commands on the host

Given the Discord connection becomes active
	When Integral registers commands for the configured application
		Then it makes `/help`, `/status`, `/model`, `/queue`, `/approvals`, `/approve`, and `/deny` available for direct-message use
			And does not register `/exit` because leaving a DM does not detach or end the conversation
Given the bound Discord user invokes a supported slash command in the configured DM
	When Integral handles the interaction
		Then it executes the equivalent command against the Discord conversation
			And `/model` reads or changes only the Discord conversation's model selection
			And `/queue` lists, edits, or deletes only the Discord conversation's messages using their stable queue IDs
			And `/approvals` lists only unresolved governed requests originating in the Discord conversation without secret values
			And `/approve` and `/deny` act only on governed requests belonging to the Discord conversation
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
		Then Integral reports the Discord conversation's model, queue, and session state
			And includes Discord listener health
			And identifies the configured bot, user, and DM without printing credentials
			And does not include messages, queue entries, or session state from the default terminal conversation
