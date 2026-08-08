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

## REPO-D1865075 — Give Pi authenticated repository lifecycle tools

Given integral provisions any interactive or isolated scheduled Pi session
	When it prepares Pi's extensions
		Then it registers `repo_list`, `repo_create`, `repo_push`, `repo_delete`, and `repo_restore`
			And describes the commit-before-push and soft-delete semantics to Pi
			And explains that creation, deletion, and restoration take effect through controlled session replacement
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
		Then integral fails session provisioning before delivering a prompt
			And identifies the unavailable connection without exposing its host path
			And removes every checkout created for that failed session

## REPO-CDA4609A — Land committed repository work through the host boundary

Given Pi has committed work on a current-run governed repository branch
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
			And records the snapshot under a quarantine ref associated with the run
			And records whether the checkout contained committed or uncommitted changes
			And makes the recovery ref visible in repository status for a later run
			And only then removes the temporary checkout
	When the checkout has no work beyond its landed canonical head
		Then integral removes it without creating an empty recovery ref
	When a recovery ref exceeds the configured retention period
		Then integral removes it without changing canonical history
			And records the expiration in host-attested repository history

## REPO-95B5606D — Soft-delete a governed repository from Pi

Given an active governed repository is visible to Pi
	When Pi calls `repo_delete` with its repository ID and expected lifecycle revision
		Then integral preserves unlanded current-run work using the same recovery boundary as run shutdown
			And records a tombstone containing the repository identity, canonical branch, prior mount path, and deletion actor
			And removes the repository from the active connection inventory
			And marks the calling session for shutdown after the tool reports durable deletion
			And prevents every other live checkout from landing after the deletion revision
			And marks every other Pi session carrying that repository stale for replacement before its next turn
			And omits the repository from later Pi sessions
			And preserves the canonical repository and its complete history
	When the expected lifecycle revision is stale
		Then integral rejects deletion without changing the repository or its active checkouts

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

Given active and soft-deleted governed repositories may exist
	When Pi calls `repo_list`
		Then integral returns each repository's stable ID, connection name, lifecycle state, lifecycle revision, canonical branch, and mount path
			And identifies recovery refs with unlanded work
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
