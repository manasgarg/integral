# Governed repository behaviors

These behaviors cover host-canonical Git repositories that Pi can create,
mount in its filesystem, edit through per-run checkouts, land through a
validated host boundary, and soft-delete without destroying history. Existing
bare repositories may enter the same lifecycle through a host connection.

<!-- Automation note (REPO-403F597E): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-515BAAB9): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-A690931F): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-CDA4609A): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-37441347): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-BB20CA23): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-95B5606D): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-F96C6AE6): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-4EB2390E): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-CEE2CA38): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-D987932B): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-D1865075): This behavior defines planned governed-repository functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-1C3B9872): This behavior defines planned governed-repository availability functionality; executable coverage will land with implementation. -->
<!-- Automation note (REPO-7B0E2F4A): Selective approval-gated repository landing is specified for the image-recipe increment; executable coverage will land with implementation. -->

## REPO-D1865075 — Give Pi authenticated repository lifecycle tools

Given integral provisions any interactive or isolated scheduled Pi session
	When it prepares Pi's extensions
		Then it registers `repo_list`, `repo_create`, `repo_push`, `repo_delete`, and `repo_restore`
			And describes the commit-before-push and soft-delete semantics to Pi
			And explains that creation and restoration replace the calling session while deletion changes mounted resources only for later sessions
			And sends every operation through the authenticated gateway control boundary
			And derives repository authority from the session instead of accepting a host path from Pi
			And keeps the tools available when no repository connection exists yet
	When a repository tool is called with an expired, revoked, or mismatched session identity
		Then integral rejects it without reading or changing repository state

## REPO-403F597E — Create a governed repository from Pi

Given Pi has an authenticated integral session
	When Pi calls `repo_create` with a unique connection name and mount path
		Then integral creates a stable repository ID
			And creates a bare canonical repository under the deployment data directory
			And initializes its canonical branch as `main`
			And records the canonical path and filesystem identity of its backing root
			And records the requested mount path with the repository connection
			And creates a checkout on a branch named for the current run
			And marks the current session for replacement after the tool reports durable creation
			And makes the repository available at that path before the next Pi prompt
			And uses the same path in every later Pi session
			And does not expose the canonical host path to Pi
	When canonical creation or checkout placement fails
		Then the tool reports failure without an active repository connection
			And removes any incomplete canonical repository and checkout created by that operation

## REPO-515BAAB9 — Constrain agent-visible resource mount paths

Given Pi or the connection CLI creates, adds, or restores a governed repository or store
	When integral validates the requested mount path
		Then it requires an absolute normalized path below `/home/pi`
			And rejects `/home/pi` itself
			And rejects `.pi`, `history`, Integral control paths, and their descendants
			And rejects traversal, a symlink escape, or a target outside the current session home
			And rejects a path equal to, above, or below another governed resource mount
			And rejects a target containing files not owned by that resource
			And records the normalized container path rather than a host path

## REPO-A690931F — Mount every active governed repository into every Pi session

Given one or more governed repository connections are active and have mount paths
	When integral provisions an interactive or isolated scheduled Pi session
		Then it creates a separate checkout for that run from each canonical branch head
			And places each checkout at its recorded mount path
			And checks out a branch whose identity includes the run ID
			And configures `origin` as a read-only integral transport for the canonical repository
			And permits `git fetch origin`
			And refuses a direct `git push origin`
			And does not mount a canonical repository or its host parent directory into the container
	When any active repository cannot be materialized at its recorded path
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And removes any partial checkout for that repository
			And provisions the session with the remaining active resources
			And tells Pi which named repository is unavailable without exposing its host path

## REPO-CDA4609A — Land directly writable repository work through the host boundary

Given Pi has committed work on a current-run governed repository branch
	And that repository's host-managed write policy is `direct`
	When Pi calls `repo_push` for that repository
		Then the container sends a Git bundle and proposed full commit ID through the authenticated gateway control boundary
			And the host derives the repository and run identity from the authenticated session
			And the host never runs Git against Pi-writable repository metadata
			And the host receives the bundle into a fresh quarantine repository
			And verifies the bundle and runs Git object integrity checks
			And validates the complete proposed tree before changing the canonical repository
			And accepts regular files, executable files, and symbolic links with safe relative targets
			And rejects Git links, unsafe paths, oversized files, and a repository over its configured limit
			And executes no hook from the bundle or canonical repository
			And advances the canonical branch to the proposed head only by compare-and-swap fast-forward
			And preserves Pi's commits without creating a host merge commit
			And records the repository ID, prior head, landed head, run ID, and changed paths in the host-attested run history
			And reports success only after the canonical ref update is durable

## REPO-7B0E2F4A — Approval-gate selected host-managed repositories

Given every governed repository has a host-managed write policy of `direct`, `approval-required`, or `denied`
	And Pi cannot change that policy
	When Pi calls `repo_push`
		Then integral derives the repository ID and policy from the authenticated session
			And never trusts a policy, host path, approval status, or repository identity supplied by Pi
	When Pi calls `repo_push` for an `approval-required` repository
		Then integral receives and validates the proposed commit through the ordinary quarantine boundary
			And stores the valid proposal under an approval-specific ref without advancing the canonical branch
			And binds the approval to the repository ID, current canonical base commit, proposed commit, complete tree digest, changed paths, originating session and run, and repository lifecycle revision
			And shows the exact commit diff and safe validation summary to the approving human
			And does not expose unvalidated Git objects to the canonical repository
	When a human approves that exact repository proposal
		Then integral revalidates the quarantined objects, complete proposed tree, repository lifecycle revision, and canonical base commit
			And invokes the repository's idempotent approved-mutation executor for that exact proposal
			And refuses any file, commit, tree, ref, or policy change made after approval was requested
	When the canonical branch or lifecycle revision changed after the proposal was created
		Then integral records a stale approval outcome without advancing the canonical branch
			And lets Pi fetch, rebase, and submit a new proposal requiring a new approval
	When a human denies the proposal or its approval expires
		Then integral leaves the canonical branch unchanged
			And retains only the bounded proposal and audit material required by policy
	When Pi calls `repo_push` for a `denied` repository
		Then integral rejects the request without accepting a proposal or changing repository state
	When Pi calls a read-only repository operation
		Then integral permits it according to ordinary session and repository policy without mutation approval
	When a trusted local operator edits an `approval-required` image-recipe repository through `integral image edit`
		Then integral treats the local CLI invocation as direct human authority for that repository
			And validates and durably commits the exact change without creating an approval request
			And records the operator, prior commit, landed commit, tree digest, and changed paths in host audit history

## REPO-37441347 — Refuse stale or malformed repository landings safely

Given a governed repository canonical branch may have advanced since a run began
	When `repo_push` proposes a head that does not descend from the current canonical head
		Then integral refuses the landing without changing the canonical repository
			And reports the current canonical head
			And permits Pi to fetch, rebase, resolve conflicts, and retry from its checkout
	When a bundle, proposed head, commit range, or tree fails validation
		Then integral refuses the landing without importing unvalidated refs into the canonical repository
			And records a redacted refusal reason in the run history
			And leaves the checkout available for Pi to correct and retry

## REPO-BB20CA23 — Preserve unlanded work when a run ends

Given a governed repository checkout differs from its landed canonical head
	When the Pi run stops, fails, times out, or is recycled
		Then integral snapshots its files without trusting or executing its `.git` metadata
			And records the snapshot in host recovery storage independent of the canonical repository
			And records whether the checkout contained committed or uncommitted changes
			And makes the recovery artifact visible in repository status for a later run
			And only then removes the temporary checkout
	When the checkout has no work beyond its landed canonical head
		Then integral removes it without creating an empty recovery artifact
	When a recovery artifact exceeds the configured retention period
		Then integral removes it without requiring or changing canonical history
			And records the expiration in host-attested repository history

## REPO-95B5606D — Soft-delete a governed repository from Pi

Given an active governed repository is visible to Pi
	Or an unavailable governed repository is visible to Pi
	When Pi calls `repo_delete` with its repository ID and expected lifecycle revision
		Then integral records a tombstone containing the repository identity, canonical branch, prior mount path, and deletion actor
			And removes the repository from the active connection inventory
			And prevents every existing checkout from landing after the deletion revision
			And rejects later `repo_push` and `git fetch origin` calls from those checkouts as `resource_soft_deleted`
			And leaves every existing Pi session and checkout running until its ordinary end
			And lets those checkouts continue local edits and Git commits
			And preserves unlanded work from each checkout when its session ordinarily ends
			And omits the repository from every session started after deletion
			And preserves the canonical repository and its complete history
			And reports that the current session retains its checkout until it ends
	When the expected lifecycle revision is stale
		Then integral rejects deletion without changing the repository or its active checkouts

## REPO-1C3B9872 — Keep repository sessions running after backing failure

Given a Pi session was provisioned with a governed repository checkout
	When trusted host code detects that the canonical repository is missing, inaccessible, invalid, or replaced by another filesystem identity
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And leaves the existing Pi session and checkout running until its ordinary end
			And lets local file edits and Git commits succeed or fail normally inside that checkout
			And rejects `repo_push`, `git fetch origin`, and later host-mediated operations with `resource_unavailable`
			And preserves unlanded work in canonical-independent recovery storage when the session ends
	When integral starts a later Pi session
		Then it omits the unavailable repository
			And tells Pi the connection name and bounded availability reason without exposing its host path

## REPO-F96C6AE6 — Restore a soft-deleted governed repository

Given a governed repository has a tombstone and its canonical repository remains available
	When Pi calls `repo_restore` with its repository ID, expected lifecycle revision, and a valid mount path
		Then integral reactivates the same stable repository and canonical history
			And records the newly chosen mount path
			And marks the current session for replacement after the tool reports durable restoration
			And creates a checkout at that path before the next Pi prompt
			And advances the lifecycle revision without rewriting repository history
	When the canonical repository is missing or the requested path is invalid
		Then integral leaves the tombstone unchanged
			And reports why restoration could not complete

## REPO-4EB2390E — Apply one lifecycle to every governed repository

Given a governed repository was created through Pi or added from an existing host path
	When Pi or the connection CLI performs a lifecycle operation
		Then integral applies the same states, revisions, tools, and restoration rules
			And does not record or expose an ownership or provenance classification
	When Pi soft-deletes it or the user removes its connection
		Then integral removes access and preserves a tombstone
			And never deletes, moves, rewrites, or changes filesystem ownership of the canonical repository merely because access was removed
			And a successful governed landing remains the only operation allowed to advance its selected canonical branch

## REPO-CEE2CA38 — Expose governed repository inventory without host paths

Given active, unavailable, and soft-deleted governed repositories may exist
	When Pi calls `repo_list`
		Then integral returns each repository's stable ID, connection name, lifecycle state, lifecycle revision, canonical branch, and mount path
			And reports a bounded availability reason for an unavailable repository
			And identifies recovery artifacts with unlanded work
			And does not return canonical host paths or another deployment's repositories
	When Pi calls a repository tool using only a path
		Then integral requires the path to resolve to exactly one repository in the authenticated session
			And otherwise requires the stable ID or connection name

## REPO-D987932B — Serialize repository lifecycle and landing operations

Given several Pi runs or host commands act on one governed repository concurrently
	When integral creates, adds, pushes, soft-deletes, or restores it
		Then the host serializes validation and state changes by stable repository ID
			And uses lifecycle revisions for connection-state compare-and-swap
			And uses canonical commit IDs for branch compare-and-swap
			And never exposes a partially updated connection record, canonical ref, checkout, or tombstone
			And a process restart recovers the last durable lifecycle state and canonical head

Given permanent deletion of repository content is outside the governed lifecycle
	When Pi or the connection CLI requests removal
		Then integral offers only soft deletion
			And leaves permanent canonical purging outside this phase
