# Message queue behaviors

These behaviors cover the server-owned durable queue for the one logical
conversation in an `$RR_HOME` deployment.

## QUEUE-5B7C2E91 — Enqueue every submitted message durably

Given the rr server is healthy
	When an attached terminal submits a non-empty message
		Then the server assigns the message a stable opaque ID
			And writes the message durably before acknowledging it
			And assigns it an order after all previously acknowledged messages
			And broadcasts the queued message and its ID to every attached terminal

## QUEUE-31A6D84F — Serialize messages through one Pi conversation

Given one message is in flight with Pi
	And one or more later messages are queued
	When the in-flight turn completes
		Then the server durably marks the in-flight message complete
			And claims the oldest remaining queued message
			And sends only that message to Pi
			And preserves acknowledged queue order regardless of submitting terminal

## QUEUE-A19D6F43 — List queued messages

Given the durable queue contains zero or more messages
	When an attached user enters `/queue ls`
		Then rr lists queued messages in delivery order
			And shows each message's stable ID and text
			And identifies the in-flight message separately
			And shows the same result in every attached terminal
			And does not send the command to Pi

## QUEUE-C84E1A70 — Edit a queued message

Given a message is durably queued and not in flight
	When an attached user enters `/queue edit <id> <text>`
		Then rr atomically replaces that message's text
			And preserves its stable ID and queue position
			And persists the edit before reporting success
			And broadcasts the edited message to every attached terminal
			And sends only the edited text when the message is later claimed

## QUEUE-2F6B9D04 — Delete a queued message

Given a message is durably queued and not in flight
	When an attached user enters `/queue delete <id>`
		Then rr atomically removes the message from the delivery queue
			And persists the deletion before reporting success
			And broadcasts the deletion to every attached terminal
			And never sends the deleted message to Pi

## QUEUE-D31A7C68 — Reject changes after a message is claimed

Given a message is in flight with Pi
	When an attached user tries to edit or delete that message ID
		Then rr rejects the operation
			And identifies the message as in flight
			And leaves the message and turn unchanged

## QUEUE-8E42F5B1 — Preserve the queue when terminals detach

Given one or more messages are durably queued
	When one terminal detaches
		Then every queued message remains stored
			And processing continues independently of that terminal
	When every terminal detaches
		Then every queued message remains stored
			And the server continues processing the queue

## QUEUE-F0C937AD — Recover the queue after a server restart

Given queued messages were acknowledged before the server stopped or crashed
	When the server starts again with the same `$RR_HOME`
		Then every acknowledged queued message is present in its prior order
			And deleted messages remain deleted
			And edits retain their latest acknowledged text
			And queue processing resumes without requiring a terminal

## QUEUE-6A1B4E82 — Order concurrent submissions consistently

Given two or more terminals are attached to the same conversation
	When they submit messages concurrently
		Then the server commits one total order for those messages
			And every attached terminal observes that same order
			And Pi receives each message once in that order

## QUEUE-947D3AC0 — Refuse an unknown queued-message ID

Given a queue edit or delete command names an unknown or deleted message ID
	When the server evaluates the command
		Then rr rejects the operation without changing the queue
			And reports that the message is not queued

## QUEUE-3C8E71B4 — Acknowledge queue mutations only after persistence

Given the durable queue storage cannot commit a submission, edit, or deletion
	When the user requests that queue mutation
		Then rr reports that the operation failed
			And does not acknowledge or broadcast the requested state
			And keeps the last committed queue state visible to every terminal
