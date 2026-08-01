# Message queue behaviors

These behaviors cover the coordinator-owned durable queue for the one logical
conversation in an `$INTEGRAL_HOME` deployment.

## QUEUE-5B7C2E91 — Enqueue every submitted message durably

Given the integral coordinator is healthy
	When an attached terminal submits a non-empty message
		Then the coordinator assigns the message a stable opaque ID
			And formats each new ID as a canonical uppercase base-36 Snowflake
			And keeps newly assigned IDs unique across coordinator restarts and clock rollback
			And writes the message durably before acknowledging it
			And assigns it an order after all previously acknowledged messages
			And records its creation time, queued state, and zero delivery attempts
			And broadcasts the queued message and its ID to every attached terminal
	When a client submits an empty or whitespace-only message
		Then the coordinator rejects it without changing the queue or conversation

## QUEUE-31A6D84F — Serialize messages through one Pi conversation

Given one message is in flight with Pi
	And one or more later messages are queued
	When the in-flight turn completes
		Then the coordinator durably marks the in-flight message complete
			And claims the oldest remaining queued message
			And sends only that message to Pi
			And increments a message's delivery-attempt count each time it is claimed
			And preserves acknowledged queue order regardless of submitting terminal

## QUEUE-A19D6F43 — List queued messages

Given the durable queue contains zero or more messages
	When an attached user enters `/queue ls`
		Then integral lists queued messages in delivery order
			And shows each message's stable ID and text
			And identifies the in-flight message separately
			And shows the same result in every attached terminal
			And does not send the command to Pi
	When the user runs `integral queue ls`
		Then integral requests the same queue snapshot from the coordinator without attaching a talk session
			And lists each message's state, stable ID, and text in delivery order
	When the user runs `integral queue ls --json`
		Then integral prints the same ordered queue snapshot as JSON

## QUEUE-C84E1A70 — Edit a queued message

Given a message is durably queued and not in flight
	When an attached user enters `/queue edit <id> <text>`
		Then integral atomically replaces that message's text
			And preserves its stable ID and queue position
			And persists the edit before reporting success
			And updates the corresponding durable user-conversation event
			And broadcasts the edited message to every attached terminal
			And sends only the edited text when the message is later claimed
	When the user runs `integral queue edit <id> <text>`
		Then integral requests the same atomic edit from the coordinator without attaching a talk session
			And confirms the edited message ID after the coordinator accepts it
	When the replacement text is empty or whitespace-only
		Then integral rejects the edit without changing the queue or conversation

## QUEUE-2F6B9D04 — Delete a queued message

Given a message is durably queued and not in flight
	When an attached user enters `/queue delete <id>`
		Then integral atomically removes the message from the delivery queue
			And persists the deletion before reporting success
			And removes the corresponding durable user-conversation event
			And broadcasts the deletion to every attached terminal
			And never sends the deleted message to Pi
	When the user runs `integral queue delete <id>`
		Then integral requests the same atomic deletion from the coordinator without attaching a talk session
			And confirms the deleted message ID after the coordinator accepts it

## QUEUE-D31A7C68 — Reject changes after a message is claimed

Given a message is in flight with Pi
	When an attached user tries to edit or delete that message ID
		Then integral rejects the operation
			And identifies the message as in flight
			And leaves the message and turn unchanged

## QUEUE-8E42F5B1 — Preserve the queue when terminals detach

Given one or more messages are durably queued
	When one terminal detaches
		Then every queued message remains stored
			And processing continues independently of that terminal
	When every terminal detaches
		Then every queued message remains stored
			And the coordinator continues offering work to the runner

## QUEUE-F0C937AD — Recover the queue after a coordinator restart

Given queued messages were acknowledged before the coordinator stopped or crashed
	When the coordinator starts again with the same `$INTEGRAL_HOME`
		Then every acknowledged queued message is present in its prior order
			And preserves its stable message ID regardless of the ID format used when it was created
			And deleted messages remain deleted
			And edits retain their latest acknowledged text
			And a message recorded as in flight is returned to queued state
			And its delivery-attempt count is preserved
			And queue processing resumes without requiring a terminal

## QUEUE-6A1B4E82 — Order concurrent submissions consistently

Given two or more terminals are attached to the same conversation
	When they submit messages concurrently
		Then the coordinator serializes durable queue mutations through one commit chain
			And commits one total order for those messages
			And every attached terminal observes that same order
			And Pi receives each message once in that order

## QUEUE-947D3AC0 — Refuse an unknown queued-message ID

Given a queue edit, delete, completion, or release operation names an unknown or deleted message ID
	When the coordinator evaluates the command
		Then integral rejects the operation without changing the queue
			And reports that the message is not queued

## QUEUE-3C8E71B4 — Acknowledge queue mutations only after persistence

Given the durable queue storage cannot commit a submission, edit, or deletion
	When the user requests that queue mutation
		Then integral reports that the operation failed
			And does not acknowledge or broadcast the requested state
			And keeps the last committed queue state visible to every terminal
