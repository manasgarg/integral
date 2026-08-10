# Durable store behaviors

These behaviors cover host-backed directories that remain writable and durable
across Pi runs. Stores use direct filesystem writes rather than the governed
Git landing protocol; Integral provides mounting, isolation, coordination,
configured snapshots, and soft deletion without interpreting
their content.


## STORE-350F3496 — Give Pi authenticated store lifecycle tools

Given integral provisions any interactive or isolated scheduled Pi session
	When it prepares Pi's extensions
		Then it registers `store_list`, `store_create`, `store_delete`, `store_restore`, `store_snapshot_list`, and `store_snapshot_restore`
			And describes direct-write durability, advisory locking, snapshots, and soft deletion to Pi
			And explains that creation, restoration, and snapshot restoration replace affected sessions while deletion changes mounted resources only for later sessions
			And sends every lifecycle operation through the authenticated gateway control boundary
			And derives store authority from the session instead of accepting a host path from Pi
			And keeps the tools available when no store connection exists yet
	When a store tool is called with an expired, revoked, or mismatched session identity
		Then integral rejects it without reading or changing store state

## STORE-6148863C — Create and attach a governed store from Pi

Given Pi has an authenticated integral session
	When Pi calls `store_create` with a unique connection name and valid mount path
		Then integral creates a stable store ID and lifecycle revision
			And creates a protected backing directory under the deployment data directory
			And records the canonical path and filesystem identity of its backing root
			And records a `host-store` connection at the requested path
			And marks the current session for replacement after the tool reports durable creation
			And mounts the store read-write at that path before the next Pi prompt
			And uses the same store and path in every later Pi session
			And does not expose the backing host path to Pi
	When backing-directory creation or mount recording fails
		Then the tool reports failure without an active store connection
			And removes any incomplete backing directory created by that operation

## STORE-18E17123 — Mount every active store read-write in every Pi session

Given one or more host-store connections are active and have mount paths
	When integral provisions an interactive or isolated scheduled Pi session
		Then it bind-mounts each backing directory read-write at its recorded mount path
			And exposes the same durable bytes to every run in that deployment
			And does not copy the store into temporary session storage
			And does not expose another deployment's stores or the backing host path
			And keeps the mount inside the container's non-root and capability-free boundary
	When any active store is missing, not a directory, or not writable by the Integral host process
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And provisions the session with the remaining active resources
			And tells Pi which named store is unavailable without exposing its host path

## STORE-815F88A3 — Treat store content as inert durable bytes

Given Pi writes, renames, or removes content in a mounted store whose backing identity remains reachable
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
			And retains configured snapshots as the recovery boundary

## STORE-F0338E2A — Snapshot changed governed stores

Given a governed store may have changed
	When a writable Pi run using it ends or the daily snapshot sweep runs
		And snapshots are configured
		Then integral acquires the shared whole-store lock
			And takes a filesystem snapshot without following symbolic links
			And records an itemized path change summary in host-attested run history when a run caused the snapshot
			And hard-links unchanged regular files from the preceding snapshot when the filesystem supports it
			And keeps no new snapshot when the store bytes are unchanged
			And retains the configured number of snapshots
			And excludes the host-managed lock namespace from store content and snapshots
	When snapshots are disabled
		Then integral does not snapshot or restore that store

## STORE-83D2CD52 — Soft-delete and restore a durable store

Given an active host-store connection is visible to Pi
	Or an unavailable host-store connection is visible to Pi
	When Pi calls `store_delete` with its store ID and expected lifecycle revision
		Then integral records a tombstone containing the store identity, prior mount path, revision, and deletion actor
			And revokes the deleted lifecycle revision from further store control operations
			And leaves every existing Pi session and store mount running until its ordinary end
			And lets reads and writes through those mounts succeed or fail according to the host filesystem
			And omits the store from every session started after deletion
			And preserves all backing content and snapshots
			And reports that the current session retains its mount until it ends
	When the last session retaining a soft-deleted store mount ends
		And snapshots are configured
		And the backing path remains available
		Then integral takes the ordinary changed-run snapshot
			And does not remount the store merely to take that snapshot
	When that backing path is unavailable as the last retaining session ends
		Then integral records the final-snapshot failure
			And leaves the tombstone and earlier snapshots unchanged
	When Pi calls `store_restore` with the store ID, expected lifecycle revision, and a valid mount path
		Then integral reactivates the same backing content
			And records the requested mount path
			And advances the lifecycle revision
			And marks the current session for replacement after the tool reports durable restoration
			And mounts the store at that path before the next Pi prompt
	When the expected lifecycle revision is stale
		Then integral rejects the operation without changing store state or mount path
	When the backing directory is missing or has a different filesystem identity
		Then integral leaves the tombstone unchanged
			And reports that restoration is unavailable without recreating the directory

## STORE-0A19F4CB — Keep store sessions running after backing failure

Given a Pi session was provisioned with a governed store mount
	When trusted host code detects that its recorded path is missing, inaccessible, the wrong type, not writable, or replaced by another filesystem identity
		Then integral marks the connection unavailable with a bounded reason
			And advances its lifecycle revision and the connection generation
			And leaves the existing Pi session and mount running until its ordinary end
			And does not unmount, replace, or otherwise normalize the session's filesystem view
			And lets later reads and writes through that mount succeed or fail according to the host filesystem
			And rejects snapshot or restoration operations that require the unavailable backing path with `resource_unavailable`
	When integral starts a later Pi session
		Then it omits the unavailable store
			And tells Pi the connection name and bounded availability reason without exposing its host path
	When a filesystem operation through the retained mount succeeds after the recorded host path becomes unavailable
		Then integral accepts the filesystem result without intervening
			And does not promise that the bytes remain reachable after the retained mount ends

## STORE-4C006F7D — Apply one lifecycle to every governed store

Given a governed store was created through Pi or added from an existing host path
	When Pi or the connection CLI performs a lifecycle operation
		Then integral applies the same states, revisions, tools, snapshot policy, and restoration rules
			And does not record or expose an ownership or provenance classification
	When Pi soft-deletes it or the user removes its connection
		Then integral removes access and preserves a tombstone
			And never deletes, moves, rewrites, or changes filesystem ownership of its backing directory merely because access was removed

## STORE-0B28DA79 — Restore a governed store snapshot safely

Given a governed store has one or more retained snapshots
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
	When the snapshot or lifecycle revision is stale
		Then integral rejects restoration without changing store content

## STORE-C38A633E — Expose store inventory without host paths

Given active, unavailable, and soft-deleted host stores may exist
	When Pi calls `store_list`
		Then integral returns each store's stable ID, connection name, lifecycle state, lifecycle revision, and mount path
			And reports a bounded availability reason for an unavailable store
			And reports snapshot availability
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
