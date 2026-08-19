# Discord DM behaviors

These behaviors cover one trusted Discord direct-message channel as its own
durable Integral conversation. The Discord DM and the default terminal
conversation keep separate histories, queues, sessions, and
task routes. In this release the logical Discord conversation maps one-to-one
to the configured native Discord DM; linking surfaces is out of scope. Discord
does not grant the agent credentials or weaken governed-operation approvals.

<!-- Automation note (DISCORD-E4BE44A7): Full verification requires an isolated Discord application and credential fixture. -->
<!-- Automation note (DISCORD-E043BBDD): Gateway reconnect and shutdown require Discord Gateway fault-injection infrastructure. -->
<!-- Automation note (DISCORD-E5BF908E): Cross-account authorization requires multiple controlled Discord identities. -->
<!-- Automation note (DISCORD-A3CB29FC): Crash-boundary recovery requires a controlled Discord history and process fault injection. -->
<!-- Automation note (DISCORD-5D67C2B9): Native delivery and typing presentation require Discord client acceptance coverage. -->
<!-- Automation note (DISCORD-89FAF039): Native command registration and private responses require a controlled Discord application. -->
<!-- Automation note (DISCORD-D235BC26): Provider degradation requires Discord authentication and transport fault injection. -->
<!-- Automation note (DISCORD-60D37149): End-to-end notification routing requires scheduled task and Discord delivery fixtures. -->
<!-- Automation note (DISCORD-0ADC0A9D): Native DM presentation requires Discord client acceptance coverage. -->
<!-- Automation note (DISCORD-45EED959): End-to-end steering timing requires a live Pi RPC turn and controlled Discord delivery. -->

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
			And reports the verified bot, user, and DM without printing the token
			And tells the user to start or restart `integral server start` to begin listening
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

## DISCORD-0ADC0A9D — Provide a native Discord DM conversation

Given the Discord listener is healthy
	And the bound user opens the configured DM
	When the listener connects or reconnects without a message to process
		Then Integral does not post an unsolicited greeting or status message
	When the user sends ordinary non-empty text
		Then Integral treats the text as conversation content without requiring a bot mention or command prefix
			And Discord shows the bot typing while the message waits for or receives a Pi turn
			And the typing indication stops before or when Integral posts the reply or error
			And the reply appears as one or more ordinary bot messages in that DM
			And Integral does not add transport labels, protocol details, message IDs, or routing instructions to the visible reply
Given the Discord listener reconnects after being offline
	When Integral imports messages that the user sent during the outage
		Then the recovered messages produce the same typing, queue, and reply experience as live messages
			And the user does not receive a duplicate reply for a message Integral already completed
Given the Discord conversation has no usable model selection
	When the bound user sends an ordinary text message
		Then Integral keeps the message in the Discord conversation's queue
			And replies once that a model must be selected with `/model`
			And does not send the message to Pi until the user selects a model
	When the user selects a model with `/model`
		Then Integral resumes processing the Discord conversation's oldest queued message
Given Integral cannot start or complete the Pi turn for a Discord message
	When it reports the failure in Discord
		Then it posts one concise warning in plain language
			And tells the user whether retrying the message is appropriate
			And does not expose stack traces, container details, credentials, or raw provider errors

## DISCORD-45EED959 — Steer an active Discord turn

Given Pi is processing a message in the Discord conversation
	And the bound user sends another non-empty text message in the configured DM
	When Integral durably accepts the later message
		Then Integral records it in the same Discord conversation with its Discord message ID and reply route
			And immediately sends it to the active Pi session as a steering message
			And does not wait for the active turn to finish before delivering the steering message to Pi
			And does not start another Pi session or container
			And records the input as steering within the same Pi run
			And keeps Discord's typing indication active
Given Pi is processing a message in the Discord conversation
	And the bound user sends two or more later text messages
	When Integral delivers them as steering
		Then it delivers the steering messages to the active Pi session in durable acceptance order
			And Pi may produce one consolidated response to the original message and its steering messages
			And Integral does not promise one assistant response per steering message
			And it posts the resulting assistant response only to the configured Discord DM
Given the Discord conversation has a warm Pi session with no turn in flight
	When the bound user sends another non-empty text message
		Then Integral sends the message to that session as the next follow-up prompt rather than as steering
Given Integral has durably accepted a Discord message for steering
	When the active turn or Pi session ends before Integral can deliver that steering message
		Then Integral keeps the message in the Discord conversation's queue
			And delivers it as the next follow-up prompt to the current or replacement session
			And does not lose it, move it to another conversation, or start a duplicate turn for it

## DISCORD-60D37149 — Route task notifications to their channel of origin

Given a Pi turn originated from the configured Discord DM
	When the turn creates a durable task
		Then Integral stamps the task with the Discord logical conversation and native DM reply route from the trusted turn context
			And does not allow Pi or task content to choose or replace that route
			And sends a receipt containing the task ID, schedule when applicable, and a one-line prompt summary only to that Discord DM
			And records the receipt in that Discord conversation's history
Given a task carries a Discord origin route
	When Integral emits a task progress, approval, completion, or failure notification
		Then Integral identifies the task by its stable ID and current state
			And summarizes the outcome or next required action in plain language
			And sends the notification only to the stored Discord DM route
			And records a successfully delivered notification in the same Discord conversation's history
			And does not display the notification in the default terminal conversation or another channel
	When the Discord delivery fails
		Then Integral retains the task's original route
			And reports the delivery failure without falling back to a terminal or another channel
Given a task was created by the CLI, a schedule, or automation without a conversation origin
	When Integral emits a task notification
		Then Integral does not infer the configured Discord DM as its destination
Given a governed request originates from the Discord conversation
	When Integral asks the user for approval
		Then it posts an ordinary bot message in the configured DM
			And includes the approval ID, safe action summary, and deadline
			And tells the user to inspect it with `/approvals show`
			And tells the user to decide it with `/approvals approve` or `/approvals deny`
	When the approval is approved, denied, stale, expired, or fails during execution
		Then Integral posts the resulting state only in the configured DM
			And includes the approval ID and a concise outcome

## DISCORD-89FAF039 — Handle Discord commands on the host

Given the Discord connection becomes active
	When Integral registers commands for the configured application
		Then it registers `/help`, `/status`, `/model`, `/queue`, and `/approvals` as native Discord application commands
			And limits the registered commands to bot direct messages
			And gives every command, subcommand, and argument a concise description in Discord's command picker
			And gives `/model` optional search terms matching the terminal model chooser
			And provides `/queue ls`, `/queue edit`, and `/queue delete` as subcommands
			And provides `/approvals ls`, `/approvals show`, `/approvals approve`, and `/approvals deny` as subcommands
			And does not register `/exit` because leaving a DM does not detach or end the conversation
Given the bound Discord user invokes a supported slash command in the configured DM
	When Integral handles the interaction
		Then it acknowledges the interaction immediately with Discord's private deferred-response state
			And executes the equivalent deployment-wide host command
			And `/status`, `/model`, `/queue`, and `/approvals` present the same durable host state from every authorized human channel
			And `/model` reads or changes the deployment's shared model selection
			And `/queue` identifies each queued conversation message by its conversation and stable queue ID
			And `/approvals` lists unresolved governed requests without secret values regardless of their notification route
			And `/approvals approve` and `/approvals deny` may decide any listed request under the same human-approval policy
			And it replaces the deferred response with the command result
			And it keeps the command result private to the bound user
			And it splits a result longer than 2,000 characters into ordered private follow-up messages
			And it does not submit the command text to Pi
	When the user invokes `/help`
		Then Integral lists every supported Discord command, subcommand, required argument, and purpose
	When the user invokes `/model` without search terms
		Then Integral privately reports the deployment's current connection and model when selected
			And lists the available connection and model choices
	When the user invokes `/model <search-terms>`
		Then Integral applies the same case-insensitive matching rules as the terminal model chooser
			And selects the model when the terms resolve to exactly one choice
			And otherwise privately lists the matching choices and tells the user how to narrow the search
			And leaves the deployment's selection unchanged when the search is ambiguous or has no match
	When the user omits a required argument or names an unknown message or approval
		Then Integral returns concise usage or not-found guidance in the private command response
			And does not reveal secret request values
	When command execution fails after Integral deferred the interaction
		Then Integral replaces the waiting state with a private failure message
			And does not leave Discord showing an indefinite pending response

## DISCORD-D235BC26 — Isolate and report Discord failures

Given the core Integral server is healthy
	When Discord authentication, registration, connection, or delivery fails
		Then Integral keeps the coordinator, gateway, runner, terminal chat, and durable queue available
			And reports the Discord connection as degraded with a redacted failure reason
			And never includes the bot token in logs, status, command output, or conversation events
	When the bound Discord user invokes `/status`
		Then Integral reports deployment-wide model, queue, task, and session state
			And includes Discord listener health
			And identifies the configured bot, user, and DM without printing credentials
			And reports conversation-specific queue and session state with an unambiguous conversation label
