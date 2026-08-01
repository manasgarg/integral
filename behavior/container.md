# Container behaviors

These behaviors cover the runner component provisioning and managing the warm
Pi RPC container.

<!-- Automation note (BOX-AB639757): The image, RPC command, session restoration, and lifecycle orchestration are automated; launching the real image is not run in the default suite because its execution environment has no Docker-daemon access. -->
<!-- Automation note (BOX-601613D4): The default suite verifies the complete Docker argument and mount specification; `npm run test:acceptance:docker` inspects the live container's kernel-enforced identity, filesystem, capabilities, resources, mounts, and network. -->
<!-- Automation note (BOX-B45DEA9B): Single-session reuse is tested at the runner lifecycle boundary; a live multi-turn provider call is not made by the offline suite. -->
<!-- Automation note (BOX-BE26C696): Timeout, release, and cleanup paths are automated at the protocol boundary; real container termination is not exercised without a Docker daemon. -->
<!-- Automation note (BOX-7D3A19E4): Idle timer and session cleanup paths are automated without waiting five real minutes or launching Docker. -->
<!-- Automation note (BOX-C28F4A61): Provisioning-failure release behavior is automated without deliberately failing a live Docker daemon. -->

## BOX-AB639757 — Start Pi for the first message

Given the coordinator, runner, and gateway are healthy
	And no Pi session is active
	And the durable queue contains a message ready for delivery
	When the runner claims the next queued message from the coordinator
		Then integral creates a fresh temporary session home
			And starts one non-root Docker container on the locked network
			And runs the immutable Pi image recorded with the conversation selection in RPC mode with session persistence and approval prompts disabled
			And runs Pi offline so Pi does not perform its own startup network operations
			And keeps container standard input attached for the lifetime of the RPC session
			And supplies the conversation's selected model connection and model
			And supplies only a sentinel credential in the authentication shape required by the selected provider
			And restores conversational context from the durable conversation record
			And sends the claimed message as a Pi `prompt` command

## BOX-E1F472A1 — Refresh one coordinated Pi runtime

Given integral begins Pi-specific OAuth or opens the model chooser
	When the npm registry reports a newer `latest` Pi version
		Then integral installs that exact version under deployment runtime state
			And uses that exact version when the model chooser builds the default Pi image
			And the chooser discovers providers and models from that image
			And records the version and immutable image identity when the user selects a model
	When the npm registry reports the same version as the installed runtime
		Then integral reuses the installed host runtime
			And the model chooser reuses the matching image when it is available
			And does not reinstall Pi
	When the npm registry cannot be reached
		And the previously installed Pi runtime and any image required by the operation are valid
		Then integral reuses the installed runtime
			And warns that it could not check for a newer Pi version
	When the npm registry cannot be reached
		And no valid installed Pi runtime exists
		Then the Pi-dependent operation exits non-zero
			And explains that no cached Pi runtime is available
Given a conversation selection records a Pi version and immutable image identity
	When the runner provisions or reuses a Pi container
		Then it uses that immutable image identity
			And treats a runtime identity change as a model-selection change
			And never substitutes another locally tagged Pi image

## BOX-601613D4 — Apply container restrictions

Given integral is provisioning a Pi container
	When Docker receives the container specification
		Then the container runs as a non-root user
			And disables privilege escalation
			And drops additional Linux capabilities
			And uses a read-only root filesystem
			And mounts `/tmp` as a size-bounded `tmpfs` with execution and set-user-ID disabled
			And mounts one fresh session home as the other writable location
			And does not mount host worker directories or repositories
			And does not mount the Docker socket
			And does not mount control-plane configuration or credentials
			And mounts only the gateway CA and fresh temporary session home as required

## BOX-B45DEA9B — Keep one warm Pi conversation

Given integral has an active Pi RPC session
	When the runner claims another message after the prior turn completes
		Then integral sends it to the same Pi process
			And sends it to the same Pi session
			And preserves preceding turns as conversational context
			And cancels a pending idle shutdown before starting the turn
			And does not start a second container

## BOX-BE26C696 — Bound a stuck turn

Given Pi does not finish a turn within the configured turn timeout
	When the timeout expires
		Then integral requests container termination
			And reports that the turn timed out
			And durably returns the in-flight message to the queue
			And removes temporary session data
			And revokes temporary session credentials
			And force-removes the Docker container if it has not exited five seconds after SIGTERM

## BOX-7D3A19E4 — Recycle an idle Pi session without ending the conversation

Given the durable queue is empty
	And the Pi session has no turn in flight
	When the Pi idle timeout expires
		Then integral terminates the Pi container
			And revokes its temporary session token
			And preserves the durable conversation record and queue
			And keeps attached terminals connected
			And starts a replacement session when another message is queued

## BOX-C28F4A61 — Return a message when Pi provisioning fails

Given the runner has claimed a queued message
	When it cannot provision or start the Pi container
		Then integral durably returns the message to its prior queue position
			And records the provisioning failure
			And reports the failure to every attached terminal
