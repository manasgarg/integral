# Terminal chat behaviors

These behaviors cover the single-user terminal interface and ephemeral
conversation lifecycle.

## CHAT-001 — Refuse chat without the server

Given no healthy rr server is reachable
	When the user runs `rr talk`
		Then the command exits non-zero
			And tells the user to run `rr server start`
			And does not start an ungoverned local Pi process

## CHAT-002 — Hold an interactive conversation

Given the terminal is interactive
	And the rr server is healthy
	When the user runs `rr talk`
		Then the terminal shows a stable input prompt
			And treats each non-empty input line as user content
			And displays assistant text emitted by Pi as assistant output
			And does not display protocol events or raw JSON
			And does not display model credentials

## CHAT-003 — Show local chat help

Given the user is in `rr talk`
	When the user enters `/help`
		Then the terminal describes `/help`, `/status`, and `/exit`
			And handles the command on the host
			And does not send the command to Pi

## CHAT-004 — Show chat status

Given the user is in `rr talk`
	When the user enters `/status`
		Then the terminal reports whether the gateway is healthy
			And reports whether the Pi container is healthy
			And identifies the configured provider and current session
			And does not print secrets

## CHAT-005 — Leave a chat

Given the user is in an active chat
	When the user enters `/exit`, sends EOF, or interrupts the client
		Then rr ends the Pi RPC session
			And terminates and removes the chat container
			And revokes the session token
			And removes the temporary chat home and transcript
			And returns terminal control to the user

## CHAT-006 — Start a fresh later conversation

Given a previous `rr talk` invocation ended
	When the user runs `rr talk` again
		Then rr starts a new Pi session with a new identity token
			And does not include previous messages
			And does not expose previous worker-created files
