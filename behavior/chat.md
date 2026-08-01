# Terminal chat behaviors

These behaviors cover interchangeable terminal views over the coordinator-owned
single-user conversation.

<!-- Automation note (CHAT-888AFAE0): Prompt, local-command, queue, and rendering contracts are automated; keystroke-level PTY interaction is not run by the non-interactive default suite. -->
<!-- Automation note (CHAT-54B8A1C3): Shared coordinator snapshots and broadcasts are automated; two real PTYs are an acceptance test. -->
<!-- Automation note (CHAT-1C4A8B7E): Detachment ownership is automated at the coordinator boundary; SIGINT delivery to a real PTY is not part of the default suite. -->

## CHAT-DB0EF523 — Refuse chat without the server

Given no healthy coordinator is reachable
	When the user runs `rr talk`
		Then the command exits non-zero
			And tells the user to start the coordinator or run `rr server start`
			And does not start an ungoverned local Pi process

## CHAT-888AFAE0 — Hold an interactive conversation

Given the terminal is interactive
	And the rr coordinator is healthy
	When the user runs `rr talk`
		Then the terminal shows a stable input prompt
			And trims input before interpreting or submitting it
			And submits each non-empty input line to the coordinator-owned queue
			And ignores empty or whitespace-only input
			And displays persisted user, assistant, and error text with its event type
			And displays assistant text emitted by Pi as assistant output
			And does not display protocol events or raw JSON
			And does not display model credentials
	When the user enters an unrecognized line beginning with `/`
		Then rr reports an unknown local command on stderr
			And does not submit the line to the coordinator or Pi

## CHAT-84D839CE — Show local chat help

Given the user is in `rr talk`
	When the user enters `/help`
		Then the terminal describes `/help`, `/status`, `/queue ls`, `/queue edit`, `/queue delete`, and `/exit`
			And handles the command on the host
			And does not send the command to Pi

## CHAT-989F5C14 — Show chat status

Given the user is in `rr talk`
	When the user enters `/status`
		Then the terminal reports whether the gateway is healthy
			And reports whether the runner is healthy
			And reports whether the Pi container is healthy
			And identifies the configured model connection or automatic-selection mode
			And identifies the current session when one is active
			And reports the queue depth and number of attached terminals
			And identifies the in-flight message when one exists
			And does not print secrets

## CHAT-54B8A1C3 — Attach every terminal to the same conversation

Given one `rr talk` terminal is attached to the deployment conversation
	When the user starts another `rr talk` with the same `$RR_HOME`
		Then the second terminal attaches to the same logical conversation
			And receives the same ordered conversation record
			And receives the same queue contents and order
			And observes the same Pi session and in-flight message
			And does not start another logical conversation or Pi container

## CHAT-D7E2F609 — Broadcast conversation events to every terminal

Given two or more terminals are attached to the same conversation
	When any terminal submits a message
		Then every attached terminal displays that same persisted user message once
	When Pi completes a response
		Then the coordinator persists the complete assistant response
			And every attached terminal displays that same response once
	When queue or session state changes
		Then every attached terminal observes the same resulting state
			And renders queue edits and deletions as host-side notices
			And renders session start and end events without exposing the session token

## CHAT-1C4A8B7E — Detach one terminal without ending the conversation

Given one or more terminals are attached to the conversation
	When one terminal enters `/exit`, sends EOF, or is interrupted
		Then rr detaches only that terminal
			And returns control to that terminal's shell
			And does not end the logical conversation
			And does not discard queued messages or persisted conversation events
			And does not disturb other attached terminals

## CHAT-93E7D20B — Reattach to the durable conversation

Given every terminal has detached
	And the rr coordinator still owns the conversation
	When the user runs `rr talk` with the same `$RR_HOME`
		Then the terminal receives a snapshot containing the existing conversation record and queue
			And omits session records from rendered conversation text
			And continues following new events without a snapshot-to-live gap
			And does not create a blank logical conversation

## CHAT-B46C81F5 — Restore conversation context in a replacement Pi session

Given the logical conversation has persisted completed turns
	And no Pi container is active
	When the runner starts a replacement Pi session for a queued message
		Then rr supplies the persisted conversation context to Pi
			And the replacement session can continue the same conversation
			And temporary files from the previous container remain unavailable

## CHAT-4F29A6D8 — Recover the conversation after a server restart

Given conversation events were acknowledged before the coordinator stopped or crashed
	When the coordinator starts again with the same `$RR_HOME`
		Then rr restores the events in their committed order
	When a terminal attaches after that restart
		Then it receives the restored conversation and current queue
			And follows subsequent events in the same logical conversation
