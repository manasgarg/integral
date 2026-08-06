# Durable store behaviors

These behaviors cover host-backed directories that remain writable and durable
across Pi runs. Stores use direct filesystem writes rather than the governed
Git landing protocol; Integral provides mounting, isolation, coordination,
snapshots for Integral-owned stores, and soft deletion without interpreting
their content.

<!-- Automation note (STORE-350F3496): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-6148863C): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-18E17123): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-815F88A3): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-77471EF0): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-F0338E2A): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-83D2CD52): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-4C006F7D): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-C38A633E): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-097B028D): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->
<!-- Automation note (STORE-0B28DA79): This behavior defines planned durable-store functionality; executable coverage will land with implementation. -->

## STORE-350F3496 — Give Pi authenticated store lifecycle tools

Given integral provisions any interactive or isolated scheduled Pi session
	When it prepares Pi's extensions
		Then it registers `store_list`, `store_create`, `store_delete`, `store_restore`, `store_snapshot_list`, and `store_snapshot_restore`
			And describes direct-write durability, advisory locking, snapshots, and soft deletion to Pi
			And explains that creation, deletion, restoration, and snapshot restoration take effect through controlled session replacement
			And sends every lifecycle operation through the authenticated gateway control boundary
			And derives store authority from the session instead of accepting a host path from Pi
			And keeps the tools available when no store connection exists yet
	When a store tool is called with an expired, revoked, or mismatched session identity
		Then integral rejects it without reading or changing store state

## STORE-6148863C — Create and attach an Integral-owned store from Pi

Given Pi has an authenticated integral session
	When Pi calls `store_create` with a unique connection name and valid mount path
		Then integral creates a stable store ID and lifecycle revision
			And creates an owner-only backing directory under the deployment data directory
			And records an Integral-owned `host-store` connection at the requested path
			And marks the current session for replacement after the tool reports durable creation
			And mounts the store read-write at that path before the next Pi prompt
			And uses the same store and path in every later Pi session
			And does not expose the backing host path to Pi
	When backing-directory creation or mount recording fails
		Then the tool reports failure without an active store connection
			And removes any incomplete Integral-owned backing directory

## STORE-18E17123 — Mount every active store read-write in every Pi session

Given one or more host-store connections are active and have mount paths
	When integral provisions an interactive or isolated scheduled Pi session
		Then it bind-mounts each backing directory read-write at its recorded mount path
			And exposes the same durable bytes to every run in that deployment
			And does not copy the store into temporary session storage
			And does not expose another deployment's stores or the backing host path
			And keeps the mount inside the container's non-root and capability-free boundary
	When any active store is missing, not a directory, or not writable by the Integral host process
		Then integral fails session provisioning before delivering a prompt
			And identifies the unavailable connection without exposing its host path
			And removes every temporary resource created for the failed session

## STORE-815F88A3 — Treat store content as inert durable bytes

Given Pi writes, renames, or removes content in a mounted store
	When the filesystem acknowledges the operation
		Then the change remains in the backing directory after the Pi session ends or is recycled
			And later sessions observe the resulting filesystem state
			And Integral does not parse, import, execute, or run Git against store content
			And Integral never follows a store-contained symlink while snapshotting or managing lifecycle state
			And files named `.git` or executable files receive no special host authority
	When Pi needs multi-file consistency or a read-modify-write update
		Then the store guidance requires atomic replacement where possible
			And requires an advisory store lock around the whole operation when atomic replacement is insufficient

## STORE-77471EF0 — Coordinate concurrent store writers with shared locks

Given several Pi runs may write one mounted store concurrently
	When Pi runs `integral-lock <store> <name> -- <command>`
		Then the helper resolves the store by authenticated session inventory
			And acquires an exclusive advisory lock from a host-managed lock namespace outside store content
			And holds the lock for the command's lifetime
			And releases the lock when the command exits, crashes, or its container stops
			And the same store and lock name exclude every other run in the deployment
	When Pi omits locking around conflicting writes
		Then Integral makes no claim that those writes are transactionally consistent
			And retains snapshots as the recovery boundary for an Integral-owned store

## STORE-F0338E2A — Snapshot changed Integral-owned stores

Given an Integral-owned store may have changed
	When a writable Pi run using it ends or the daily snapshot sweep runs
		Then integral acquires the shared whole-store lock
			And takes a filesystem snapshot without following symbolic links
			And records an itemized path change summary in host-attested run history when a run caused the snapshot
			And hard-links unchanged regular files from the preceding snapshot when the filesystem supports it
			And keeps no new snapshot when the store bytes are unchanged
			And retains the configured number of snapshots
			And excludes the host-managed lock namespace from store content and snapshots
	When an operator-owned host-store connection is active
		Then integral does not snapshot or restore that external directory
			And connection setup warns that its backup and recovery remain the operator's responsibility

## STORE-83D2CD52 — Soft-delete and restore a durable store

Given an active host-store connection is visible to Pi
	When Pi calls `store_delete` with its store ID and expected lifecycle revision
		Then integral records a tombstone containing the store identity, ownership, prior mount path, revision, and deletion actor
			And marks every session carrying the store stale for shutdown or replacement
			And revokes the deleted lifecycle revision from further store control operations
			And omits the store from later Pi sessions
			And preserves all backing content and Integral-owned snapshots
	When Pi calls `store_restore` with the store ID, expected lifecycle revision, and a valid mount path
		Then integral reactivates the same backing content
			And records the requested mount path
			And advances the lifecycle revision
			And marks the current session for replacement after the tool reports durable restoration
			And mounts the store at that path before the next Pi prompt
	When the expected lifecycle revision is stale
		Then integral rejects the operation without changing store state or mount path

## STORE-4C006F7D — Distinguish Integral-owned and operator-owned stores

Given a host store was created by Pi
	When it is soft-deleted or its connection is removed
		Then its Integral-owned backing directory and snapshots remain in deployment data
			And no Pi tool or connection-removal flow can permanently purge them
Given a host store was added from an existing host path
	When Pi soft-deletes it or the user removes its connection
		Then integral removes access and preserves a tombstone
			And never deletes, moves, rewrites, snapshots, or changes ownership of the operator-owned directory merely because access was removed

## STORE-0B28DA79 — Restore an Integral-owned store snapshot safely

Given an Integral-owned store has one or more retained snapshots
	When Pi calls `store_snapshot_list`
		Then integral returns stable snapshot IDs, creation times, originating run IDs when present, and itemized path summaries
			And does not return snapshot host paths
	When Pi calls `store_snapshot_restore` with a snapshot ID and expected lifecycle revision
		Then integral serializes the restore against lifecycle and snapshot operations
			And takes a pre-restore snapshot of the current bytes
			And replaces store content from the requested snapshot without following symbolic links
			And preserves host-managed lock state outside the restored content
			And advances the lifecycle revision
			And marks every session carrying the store stale for shutdown or replacement
			And reports success only after the restored state and pre-restore recovery snapshot are durable
	When the store is operator-owned or the snapshot or lifecycle revision is stale
		Then integral rejects restoration without changing store content

## STORE-C38A633E — Expose store inventory without host paths

Given active and soft-deleted host stores may exist
	When Pi calls `store_list`
		Then integral returns each store's stable ID, connection name, ownership, lifecycle state, lifecycle revision, and mount path
			And reports snapshot availability for an Integral-owned store
			And does not return backing host paths or another deployment's stores
	When Pi calls a store tool using only a path
		Then integral requires the path to resolve to exactly one store in the authenticated session
			And otherwise requires the stable ID or connection name

## STORE-097B028D — Serialize store lifecycle operations

Given several Pi runs or host commands act on one store concurrently
	When integral creates, adds, soft-deletes, or restores it
		Then the host serializes lifecycle changes by stable store ID
			And uses lifecycle revisions for compare-and-swap
			And never exposes a partially updated connection record, mount path, or tombstone
			And a process restart recovers the last durable lifecycle state
Given permanent deletion of store content is outside the governed lifecycle
	When Pi or the connection CLI requests removal
		Then integral offers only soft deletion
			And leaves permanent backing-directory purging outside this phase
