# Container behaviors

These behaviors cover the runner component provisioning and managing the warm
Pi RPC container.

<!-- Automation note (BOX-AB639757): The image, RPC command, session restoration, and lifecycle orchestration are automated; launching the real image is not run in the default suite because its execution environment has no Docker-daemon access. -->
<!-- Automation note (BOX-601613D4): The default suite verifies the complete Docker argument and mount specification; `npm run test:acceptance:docker` inspects the live container's kernel-enforced identity, filesystem, capabilities, resources, mounts, and network. -->
<!-- Automation note (BOX-B45DEA9B): Single-session reuse is tested at the runner lifecycle boundary; a live multi-turn provider call is not made by the offline suite. -->
<!-- Automation note (BOX-BE26C696): Timeout, release, and cleanup paths are automated at the protocol boundary; real container termination is not exercised without a Docker daemon. -->
<!-- Automation note (BOX-7D3A19E4): Idle timer and session cleanup paths are automated without waiting five real minutes or launching Docker. -->
<!-- Automation note (BOX-C28F4A61): Provisioning-failure release behavior is automated without deliberately failing a live Docker daemon. -->
<!-- Automation note (BOX-40521095): Package policy, authenticated control routing, immutable image replacement, and recipe identity are automated; the Docker acceptance profile verifies packages in a live image. -->
<!-- Automation note (BOX-6A91C3E7): Host-managed image-recipe projection, Git proposal approval, constrained build context, fresh floating resolution, and exact-tree activation are automated, with live builds covered by the Docker acceptance profile. -->

## BOX-AB639757 — Start Pi for the first message

Given the coordinator, runner, and gateway are healthy
	And no Pi session is active
	And the durable queue contains a message ready for delivery
	When the runner claims the next queued message from the coordinator
		Then integral creates a fresh temporary session home
			And starts one non-root Docker container for Pi on the locked network
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
			And distinguishes managed images built from different Integral image recipes
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
			And mounts one fresh session home and explicitly configured host stores as the only writable host filesystems
			And places governed per-run repository checkouts only inside that fresh session home
			And mounts each host store only at its recorded mount path
			And does not mount canonical repositories or unconfigured host directories
			And does not mount the Docker socket
			And does not mount control-plane configuration or credentials
			And mounts only the gateway CA, curated read-only run history, fresh temporary session home, store lock namespace, and configured store directories as required

## BOX-B45DEA9B — Keep one warm Pi conversation

Given integral has an active Pi RPC session
	When the runner claims another message after the prior turn completes
		Then integral sends it to the same Pi process
			And sends it to the same Pi session
			And preserves preceding turns as conversational context
			And cancels a pending idle shutdown before starting the turn
			And does not start a second Pi container or duplicate an existing MCP sidecar

## BOX-BE26C696 — Bound a stuck turn

Given Pi does not finish a turn within the configured turn timeout
	When the timeout expires
		Then integral requests container termination
			And reports that the turn timed out
			And durably returns the in-flight message to the queue
			And removes temporary session data
			And revokes temporary session credentials
			And terminates every MCP sidecar owned by the timed-out session
			And force-removes the Docker container if it has not exited five seconds after SIGTERM

## BOX-7D3A19E4 — Recycle an idle Pi session without ending the conversation

Given the durable queue is empty
	And the Pi session has no turn in flight
	When the Pi idle timeout expires
		Then integral terminates the Pi container
			And terminates every MCP sidecar owned by that Pi session
			And revokes its temporary session token
			And preserves the durable conversation record and queue
			And keeps attached terminals connected
			And starts a replacement session when another message is queued

## BOX-C28F4A61 — Return a message when Pi provisioning fails

Given the runner has claimed a queued message
	When it cannot provision or start the Pi container
		Then integral durably returns the message to its prior queue position
			And terminates every partially started MCP sidecar
			And records the provisioning failure
			And reports the failure to every attached terminal

## BOX-40521095 — Govern Pi image package changes

Given Pi runs in an immutable managed image without host Docker access
	When Pi lists the image's Debian packages through Integral's authenticated control pathway
		Then Integral returns the durable desired package set and its revision
			And includes the base packages required by the managed image
	When Pi requests installation of valid Debian package names at the current revision
		Then Integral builds a replacement image from the selected exact Pi version
			And obtains packages only through the base image's configured APT repositories
			And records the new desired package set and immutable image identity
			And replaces the current container after the active turn completes
	When Pi requests an upgrade of desired packages at the current revision
		Then Integral rebuilds the replacement image without cached package layers
			And records a new revision and immutable image identity
	When Pi submits command syntax, an unknown package for upgrade, or a stale revision
		Then Integral rejects the request without changing package state or the selected image
	When the active Dockerfile declares Pi with a floating version such as `latest`
		And a human approves a fresh rebuild of that recipe
		Then Integral resolves Pi again during the build instead of overriding the Dockerfile with the prior selected version
			And records the version and immutable image identity that were actually installed

## BOX-6A91C3E7 — Let Pi author its next managed image

Given Integral owns a dedicated governed Git repository for the deployment's Pi image overlay
	And Integral's foundational Pi image, runtime user, gateway trust, entrypoint, and security constraints are outside that repository
	And the image repository has an immutable host-managed `approval-required` write policy
	When Integral provisions a Pi session
		Then it gives Pi a writable per-run checkout of the active image-recipe commit at a documented container path
			And includes a Dockerfile based on the exact host-managed foundational image reference
			And tells Pi that it runs in an ephemeral managed container
			And tells Pi that edits affect only a future replacement image after human approval
			And does not mount the canonical host repository, Docker socket, build credentials, or host Dockerfile into the container
	When Pi commits an image-recipe change and submits it through `repo_push`
		Then Integral treats the commit as an image proposal governed by `REPO-7B0E2F4A`
			And presents the exact Dockerfile and artifact diff, base commit, proposed commit, and tree digest for approval
			And keeps the active recipe ref and selected image unchanged before approval
	When the active Dockerfile declares an exact package version or immutable image digest
		Then Integral uses that exact declaration on every build
	When the active Dockerfile declares a floating package version, mutable image tag, or unversioned operating-system package
		Then Integral treats resolution at build time as intentional recipe behavior
			And does not describe the recipe commit as a reproducible package lock
			And tells an approving human that repository state may resolve differently at execution time
	When Pi requests a fresh rebuild of the active image recipe
		Then Integral creates an approval request bound to the active recipe commit, foundational image reference, and floating-resolution intent
			And does not build or select an image before approval
	When a trusted local operator runs `integral image edit`
		Then Integral validates and commits the Dockerfile change directly through the host boundary
			And records the operator and exact Git change without creating an approval request
	When a trusted local operator runs `integral image rebuild`
		Then Integral treats the command itself as direct human authorization to rebuild the active recipe
			And records the operator without creating an approval request or inventing a Pi session
	When host automation or a remote API requests a fresh rebuild without starting Pi
		Then Integral creates the same governed rebuild request used for Pi
			And records the external actor instead of inventing a Pi session
			And requires human approval before building
	When a human approves the exact image proposal
		Then Integral builds only the approved commit and complete tree digest
			And uses a build context containing only validated files from that tree
			And provides no host source tree, session credentials, Docker socket, or undeclared secret to the build
			And applies bounded build time, CPU, memory, output size, and network policy
			And records the foundational image reference, recipe base and proposal commits, tree digest, approval ID, and resulting immutable image digest
	When Integral executes a fresh rebuild authorized by approval or the trusted local CLI
		Then Integral pulls mutable base references again
			And reruns dependency installation without Docker layer-cache reuse
			And refreshes package indexes within the build as directed by the Dockerfile
			And resolves `latest`, ranges, mutable tags, and unversioned packages against their configured repositories at build time
			And never substitutes an older selected package version for a floating Dockerfile declaration
			And records the recipe commit, prior image digest, resulting image digest, and actual installed package inventory
			And permits the resulting image digest and installed inventory to differ from an earlier build of the same recipe commit
	When the approved image build and validation succeed
		Then Integral compare-and-swap advances the active recipe ref from the approved base to the approved commit
			And selects the resulting immutable image for replacement sessions
			And starts or recycles Pi according to the approval continuation lifecycle
	When the build or image validation fails
		Then Integral records and broadcasts a failed approval outcome
			And leaves the active recipe ref and selected image unchanged
			And keeps the proposal commit available according to bounded audit and recovery policy
	When Pi proposes a recipe that changes the foundational image boundary or requires an undeclared build input
		Then Integral rejects it without requesting approval or starting a build
	When a later Pi session starts from an activated recipe
		Then its projected image-recipe checkout identifies the exact active commit and host-managed foundational image reference
			And Pi can propose a rollback or further change through the same approval-gated path
