# Schedule behaviors

These behaviors cover Pi-managed schedules, durable occurrence delivery, and
isolated run-to-completion task execution.

## SCHEDULE-55BD779F — Manage schedules through the gateway

Given Pi has an active integral session
	When Pi creates a recurring schedule with a five-field cron expression, IANA timezone, and self-contained task prompt
		Then the request passes through the authenticated gateway control boundary
			And the scheduler validates the expression, timezone, minimum frequency, and task size
			And durably records a stable schedule ID and revision before acknowledging it
			And does not expose component credentials or endpoints to Pi
	When Pi creates a one-time schedule with a future execution instant and self-contained task prompt
		Then the scheduler applies the same authenticated and durable creation boundary
			And records the trigger as one-time
	When Pi lists, updates, disables, enables, or deletes one of its schedules
		Then the scheduler applies the operation to the stable schedule ID
			And an update requires the expected current revision
			And an accepted mutation is durable before it is reported to Pi
			And disabling or deleting a schedule prevents new occurrences without discarding an occurrence already due

## SCHEDULE-22FF69D9 — Preserve schedule definition history in Git

Given the scheduler owns a private Git repository under the deployment data directory
	When it accepts creation, update, enable, disable, deletion, or restoration of a schedule
		Then it writes the canonical schedule definition or deletion to that repository
			And creates one commit identifying the schedule ID, revision, operation, timestamp, and authenticated actor
			And acknowledges the mutation only after the commit is durable
			And serializes concurrent mutations into one commit order
			And never commits component credentials, gateway session identities, occurrence state, task output, or attempt records
	When a mutation is interrupted before its commit becomes durable
		Then the scheduler recovers the last committed definition state
			And does not expose the incomplete revision as current
	When a user inspects a schedule's definition history
		Then integral returns its committed revisions in order, including deleted definitions
	When a user restores a prior definition revision
		Then integral commits that definition as a new current revision
			And does not rewrite or remove the intervening history

## SCHEDULE-A1F47A7A — Materialize each due occurrence durably

Given an enabled schedule reaches its next execution instant
	When the scheduler evaluates due work
		Then it durably creates an occurrence before dispatching it
			And derives a stable execution ID from the schedule ID, schedule revision, and scheduled UTC instant
			And snapshots the task prompt and immutable Pi execution profile into the occurrence
			And never creates a second logical occurrence for the same execution ID after restart or clock rollback
			And calculates the next recurring instant using the schedule's IANA timezone and defined daylight-saving behavior

## SCHEDULE-52697825 — Dispatch an occurrence idempotently

Given the scheduler has a due occurrence not yet accepted by the coordinator
	When it submits that execution ID to the coordinator
		Then the coordinator durably accepts one task-queue record for that execution ID
			And returns that same record when an identical submission is repeated
			And rejects a repeated execution ID whose immutable task data differs
			And the scheduler retries unavailable or ambiguous delivery without creating duplicate logical work

## SCHEDULE-033C050E — Isolate task execution from interactive talk

Given the coordinator task queue contains an occurrence ready to run
	And an interactive Pi container may already be active
	When the task executor claims the occurrence
		Then it never sends the task to the interactive container
			And creates a fresh temporary home, gateway session identity, and Pi container for the attempt
			And does not restore the interactive conversation transcript into the task
			And supplies only the self-contained task prompt and trusted schedule, execution, and attempt metadata
			And permits the interactive container to remain separate from the task container

## SCHEDULE-930581F7 — Require a clean one-shot exit for task success

Given an isolated task container is processing exactly one occurrence
	When Pi produces the expected protocol-level completion and then exits naturally with status zero
		Then the coordinator durably records the complete task result
			And durably records a pending scheduler acknowledgement
			And only then reports successful execution
	When the task times out, is cancelled, rejects the prompt, violates the protocol, exits non-zero, or is forcibly terminated
		Then integral records an unsuccessful attempt
			And does not treat partial output as a successful task result
			And does not send a successful acknowledgement to the scheduler
	When any task attempt finishes
		Then the runner revokes that attempt's gateway identity
			And removes its container and temporary home
			And never retains the container for another task or talk turn

## SCHEDULE-E85BDCAD — Do not retry a failed recurring occurrence

Given a recurring occurrence has been durably accepted by the coordinator
	When delivery or capacity fails before its isolated Pi container starts
		Then integral keeps the occurrence pending for an execution attempt
	When its isolated Pi container starts and the attempt does not complete successfully
		Then the coordinator durably marks that occurrence failed
			And does not return it to the active task queue
			And acknowledges the terminal failure to the scheduler
			And retains the failed occurrence and attempt for inspection
	When the runner or coordinator recovers an occurrence recorded as running with an unknown outcome
		Then it marks that recurring occurrence failed rather than executing it again
	When the schedule reaches its next recurring instant after an earlier occurrence failed
		Then the scheduler creates the next independent occurrence normally
			And the earlier failure does not delay or replace it

## SCHEDULE-4205553B — Retry a one-time task until clean success

Given a one-time task has not completed successfully
	When delivery fails or an isolated execution attempt is unsuccessful
		Then integral retains the same logical execution ID in the active task queue
			And records the unsuccessful attempt separately
			And schedules another attempt with capped backoff
			And uses a fresh attempt ID, temporary home, gateway identity, and container for that attempt
	When the runner or coordinator recovers the one-time task with an unknown in-flight outcome
		Then it returns the same logical execution ID to pending state for another isolated attempt
	When Pi completes the task and exits cleanly
		Then integral clears the task from the active queue only after durable completion
	When an operator explicitly cancels the task
		Then integral records cancellation as the only non-successful terminal outcome
			And retains its execution and attempt history for inspection

## SCHEDULE-42E63F16 — Recover scheduler acknowledgement idempotently

Given the coordinator has durably completed a task or terminally failed a recurring occurrence
	When scheduler acknowledgement is unavailable or its response is lost
		Then the coordinator retains the acknowledgement in a durable outbox
			And retries the same execution ID and outcome after component restart
			And the scheduler applies repeated identical acknowledgements without changing the recorded outcome
			And neither component causes the task to execute again because acknowledgement was repeated

## SCHEDULE-81B854FB — Expose stable task identity for side-effect idempotency

Given Pi is running an isolated task attempt
	When integral supplies its trusted task context
		Then the context includes the stable schedule ID, execution ID, scheduled instant, and attempt number
			And retries of a one-time task retain the execution ID while changing the attempt identity
			And Pi can use the execution ID as an idempotency key for external operations
			And integral does not claim that coordinator idempotency prevents repeated external effects after an ambiguous failure

## SCHEDULE-E141FFD9 — Inspect and recover scheduled work from the CLI

Given schedules and task occurrences exist in any state
	When the user runs the schedule list, show, or run-history command
		Then integral reports stable schedule and execution IDs, trigger type, state, scheduled instant, and attempt history
			And JSON output represents the same information structurally
	When the user runs the schedule definition-history command
		Then integral reports the Git-backed definition revisions separately from occurrence run history
			And can show the canonical definition at a requested revision
	When the user disables or enables a schedule from the CLI
		Then integral applies the same durable schedule mutation used by Pi
	When the user cancels an active one-time task
		Then integral requires an explicit execution ID
			And records the operator action durably without deleting execution history
	When the user requests another attempt for a failed recurring occurrence
		Then integral rejects the request
			And leaves the failed occurrence terminal
			And identifies the next schedule occurrence as the way recurring work runs again

## SCHEDULE-8912B5E6 — Coalesce missed recurring instants

Given an enabled recurring schedule passes more than one execution instant while scheduling is unavailable
	When the scheduler recovers
		Then it creates only the latest missed occurrence
			And records the earlier missed instants as coalesced for inspection
			And does not silently present coalesced instants as successfully executed
			And resumes calculation from the schedule's next future instant

## SCHEDULE-FDFA799E — Prevent overlapping occurrences of one schedule

Given one occurrence of a recurring schedule is running
	When another occurrence of that schedule becomes due
		Then the scheduler may materialize the later occurrence durably
			And the coordinator does not start it before the running occurrence reaches a terminal outcome
			And work from other schedules and interactive talk remains eligible to run
