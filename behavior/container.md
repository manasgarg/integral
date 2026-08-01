# Container behaviors

These behaviors cover provisioning and managing the warm Pi RPC container.

## BOX-AB639757 — Start Pi for the first message

Given the server and gateway are healthy
	And no chat is active
	When the user runs `rr talk`
		And enters the first non-empty message
		Then rr creates a fresh temporary session home
			And starts one non-root Docker container on the locked network
			And runs the pinned Pi image in RPC mode
			And sends the user's message as a Pi `prompt` command

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

Given `rr talk` has an active Pi RPC session
	When the user submits a message after the prior turn completes
		Then rr sends it to the same Pi process
			And sends it to the same Pi session
			And preserves preceding turns as conversational context
			And does not start a second container

## BOX-64D9E7BA — Serialize rapid input

Given a Pi turn is running
	When the user submits another message
		Then rr queues the message in memory
			And waits for the current turn to end before sending it
			And delivers queued messages in submission order

## BOX-BE26C696 — Bound a stuck turn

Given Pi does not finish a turn within the configured turn timeout
	When the timeout expires
		Then rr terminates the container
			And reports that the turn timed out
			And removes temporary session data
			And revokes temporary session credentials
