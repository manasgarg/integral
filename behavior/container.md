# Container behaviors

These behaviors cover provisioning and managing the warm Pi RPC container.

## BOX-AB639757 — Start Pi for the first message

Given the server and gateway are healthy
	And no Pi session is active
	And the durable queue contains a message ready for delivery
	When the server claims the next queued message
		Then rr creates a fresh temporary session home
			And starts one non-root Docker container on the locked network
			And runs the pinned Pi image in RPC mode
			And restores conversational context from the durable conversation record
			And sends the claimed message as a Pi `prompt` command

## BOX-601613D4 — Apply container restrictions

Given rr is provisioning a Pi container
	When Docker receives the container specification
		Then the container runs as a non-root user
			And disables privilege escalation
			And drops additional Linux capabilities
			And uses a read-only root filesystem
			And limits writable access to bounded temporary locations
			And does not mount host worker directories or repositories
			And does not mount the Docker socket
			And does not mount control-plane configuration or credentials
			And mounts only the gateway CA and fresh temporary session home as required

## BOX-B45DEA9B — Keep one warm Pi conversation

Given rr has an active Pi RPC session
	When the server claims another message after the prior turn completes
		Then rr sends it to the same Pi process
			And sends it to the same Pi session
			And preserves preceding turns as conversational context
			And does not start a second container

## BOX-BE26C696 — Bound a stuck turn

Given Pi does not finish a turn within the configured turn timeout
	When the timeout expires
		Then rr terminates the container
			And reports that the turn timed out
			And durably returns the in-flight message to the queue
			And removes temporary session data
			And revokes temporary session credentials

## BOX-7D3A19E4 — Recycle an idle Pi session without ending the conversation

Given the durable queue is empty
	And the Pi session has no turn in flight
	When the Pi idle timeout expires
		Then rr terminates the Pi container
			And revokes its temporary session token
			And preserves the durable conversation record and queue
			And keeps attached terminals connected
			And starts a replacement session when another message is queued

## BOX-C28F4A61 — Return a message when Pi provisioning fails

Given the server has claimed a queued message
	When it cannot provision or start the Pi container
		Then rr durably returns the message to its prior queue position
			And records the provisioning failure
			And reports the failure to every attached terminal
