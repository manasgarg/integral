# Run history behaviors

These behaviors define the durable record of agent executions and the curated,
read-only history made available inside later agent environments. A run is one
Pi container lifetime: either a warm interactive session or one isolated
scheduled-task attempt.

<!-- Automation note (RUN-B1D837E0): Record creation, finalization, and restart recovery can be automated at the runner's filesystem and process boundaries without a live model provider. -->
<!-- Automation note (RUN-01CA16F2): History selection and mount specifications can be automated without Docker; `npm run test:acceptance:docker` must verify the live read-only mount. -->
<!-- Automation note (RUN-79BACB0C): Archive projection and redaction can be automated with synthetic credentials and protocol events. -->
<!-- Automation note (RUN-770B8FFA): Concurrent live-archive consistency can be automated with controlled run lifecycles and filesystem boundaries. -->
<!-- Automation note (RUN-88706C0D): Usage normalization and objective learning-signal summaries can be automated with synthetic provider responses, tool events, corrections, and termination outcomes. -->
<!-- Automation note (RUN-B13114A3): The live read-only archive mount can be automated without Docker; `npm run test:acceptance:docker` must verify the live mount and write refusal. -->

## RUN-B1D837E0 — Keep a durable record of every agent run

Given the runner is about to start a warm interactive Pi session or an isolated scheduled-task attempt
	When integral assigns the container a run identity
		Then it creates a durable run record under `<INTEGRAL_HOME>/data/runs/<run-id>` before starting Pi
			And records whether the run is interactive or scheduled
			And records its immutable model and Pi runtime identity
			And records its start time and applicable schedule, execution, and attempt identities
	When integral supplies input to Pi or receives agent output during that run
		Then it appends the input, assistant output, and tool activity needed to reconstruct the run
			And preserves their observed order
	When the run ends for any reason
		Then integral durably records the finish time and host-observed termination reason
			And records the declared task outcome when one exists without treating it as host-attested success
			And finalizes the record before removing the temporary session home
	When integral recovers a record whose run did not reach finalization
		Then it marks the run interrupted with the available host evidence
			And does not invent a successful outcome

## RUN-88706C0D — Record evidence the agent can learn from

Given integral is recording a run
	When it records the run's identity and operating conditions
		Then it records the run ID, run kind, parent or prior-attempt run IDs when applicable, model provider and model, Pi runtime identity, start time, finish time, and elapsed time
			And records the configured turn, idle, and task ceilings that applied
			And records schedule, execution, attempt, and retry numbers when applicable
	When a turn occurs
		Then it records the complete agent-visible input and output in observed order
			And records whether input was an original request, follow-up, steering message, retry instruction, or task-outcome reminder
			And records each tool name, redacted agent-visible arguments, redacted result, status, error, and elapsed time
			And records failed commands, failed validations, refused gateway operations, timeouts, cancellations, and task outcome declarations as typed events
			And gives each event a stable identity that summaries can reference
	When the model provider reports usage for a turn
		Then integral preserves the provider's usage categories
			And normalizes available input, output, cache-read, cache-write or cache-creation, reasoning, and total token counts
			And records available monetary cost and currency without estimating missing cost
			And counts every provider-reported request exactly once, including a retry that consumed tokens
			And aggregates each available usage category for the complete run
			And reports cache reuse as a ratio when it can be calculated from reported counts
	When the provider omits a usage category
		Then integral records that category as unavailable rather than zero
			And does not estimate tokens from text length
	When the user corrects, redirects, rejects, or retries earlier work
		Then integral records that feedback as an event in the run where it was received
			And links it to the earlier run or event when the relationship is known
			And does not rewrite the finalized earlier run
	When integral finalizes the run
		Then it writes a machine-readable learning-signal summary beside the ordered activity
			And summarizes objective counts and references for tool failures, command failures, validation failures, denied operations, timeouts, cancellations, retries, steering, user corrections, and outcome status
			And includes the run-level token, cache, cost, and elapsed-time aggregates
			And distinguishes host-observed facts, provider-reported values, user feedback, and agent declarations
			And does not infer an unobserved mistake, quality score, or cause
			And does not store or expose private provider reasoning that was not part of the agent-visible protocol

## RUN-01CA16F2 — Give each agent a view of earlier and current runs

Given one or more runs were finalized before integral prepares a new agent environment
	When integral provisions an interactive or scheduled-task container
		Then it mounts the deployment's agent-safe durable run archive read-only at `$HOME/history/runs`
			And makes every retained finalized run in that deployment available there
			And provides a machine-readable index ordered by run start time
			And provides each run's metadata, ordered activity, learning-signal summary, usage, and outcome under its run ID
			And includes successful, failed, interrupted, cancelled, and timed-out runs
			And includes earlier attempts of the same one-time scheduled task
			And does not require the agent to call a host tool or network service to inspect it
Given no earlier run was retained before integral prepares a new agent environment
	When integral provisions the container
		Then `$HOME/history/runs` exists as a readable archive mount containing the new current run
			And the machine-readable index identifies that run as running and contains no finalized runs
Given integral has begun the run for a new agent environment
	When it provisions the container
		Then it makes `$HOME/history/current` a read-only view of that run's archive record
			And exposes its running metadata, ordered activity, and provisional learning-signal and usage summary
	When the current run records input, output, tool activity, provider usage, feedback, or failure
		Then `$HOME/history/current` reflects the newly recorded evidence while the session remains active
	When integral finalizes the current run
		Then `$HOME/history/current` reflects its final status, outcome, elapsed time, and final learning-signal summary before the environment is removed

## RUN-79BACB0C — Expose run evidence without exposing authority

Given integral is recording agent-visible run evidence in the durable archive
	When it writes metadata or activity that Pi may later inspect
		Then it includes the prompts, agent-visible tool inputs and results, assistant output, and host-observed outcome
			And excludes gateway session tokens, real provider credentials, component authentication, and credential-bearing proxy URLs
			And excludes host-only configuration, locks, and mutable queue state
			And mounts only the agent-safe run archive rather than `<INTEGRAL_HOME>` or unrelated host state
			And exposes the current run without providing a writable path back to the durable record
	When an agent attempts to modify, rename, or delete history content
		Then the container filesystem refuses the change
			And the durable host record remains unchanged

## RUN-770B8FFA — Keep the mounted run archive live and consistent

Given integral has mounted the durable run archive into an active agent environment
	When any run starts, records activity, or finalizes while that agent remains active
		Then the corresponding archive changes become visible under `$HOME/history/runs` without restarting Pi
			And the machine-readable index reflects each durable run state in run-start order
			And readers never observe an index entry before its run record exists
			And readers never observe a finalized index state before the final metadata, outcome, usage, and learning signals are durable
	When the current run writes evidence or reaches its outcome
		Then `$HOME/history/current` and its record under `$HOME/history/runs/<run-id>` reflect the same durable evidence
Given integral restarts with an existing durable run archive
	When it prepares the next agent environment
		Then the environment receives the same retained run history as before the restart
			And container or temporary session-home cleanup does not remove that history

## RUN-B13114A3 — Mount the complete run archive into every agent invocation

Given Pi is running in an authenticated interactive session or isolated scheduled-task attempt
	And the session may have originated from the terminal, Discord, or another supported human channel
	When Integral provisions the Pi environment
		Then `$HOME/history/runs` exposes the complete live deployment archive without requiring a host tool or network request
			And each run exposes its metadata, ordered agent-visible activity, learning-signal summary, usage, declared outcome, and host-observed termination or failure
			And run metadata identifies its kind, start and finish times, outcome, and applicable schedule, execution, attempt, and prior-run identities
			And Pi can locate all attempts for a task by execution ID using the machine-readable index and run metadata
			And the same archive is available to terminal conversations, Discord conversations, and scheduled-task attempts
	When Pi reads the mounted archive
		Then Integral applies the same credential redaction and authority boundaries to every record
			And Pi cannot alter, rename, or delete durable run evidence through the mount
