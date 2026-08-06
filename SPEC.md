# integral TypeScript Reimplementation — Phase 1

Phase 1 provides one local user with a terminal conversation backed by Pi in a
locked-down Docker container. A TypeScript host process owns the CLI, container
lifecycle, external connections, credentials, and an HTTP(S) gateway. The
container has no direct internet access and never receives a real credential.

The package is named `@pirogram/integral` and the binary is named `integral`. The server and terminal client are
separate foreground processes. Each `$INTEGRAL_HOME` owns exactly one durable logical
conversation and message queue. Any number of `integral talk` processes may attach to
it simultaneously; they see the same ordered messages, replies, queue, and Pi
session state. Closing a terminal only detaches that view. Multiple integral
deployments may run on one machine when they use different `$INTEGRAL_HOME` roots and
non-conflicting component ports.

`INTEGRAL_HOME` selects the deployment root and defaults to `$HOME/.integral`.
`INTEGRAL_GATEWAY_PORT`, `INTEGRAL_COORDINATOR_PORT`, `INTEGRAL_RUNNER_PORT`, and
`INTEGRAL_SCHEDULER_PORT` select distinct component ports and default to `7310`,
`7311`, `7312`, and `7313`. `INTEGRAL_LOG_LEVEL` and
`INTEGRAL_LOG_FORMAT` override logging configuration. All integral-specific variables are
resolved once when a process starts. The Pi container does not inherit them or
the rest of the host shell environment.

The server consists of four components: the coordinator owns terminal clients,
the durable conversation queue, and the durable task queue; the runner owns Pi
containers; the gateway owns governed egress, credential injection, and the
Pi-facing scheduling control boundary; and the scheduler owns schedule
definitions, due occurrences, and dispatch retry timing. `integral server
start` runs all four listeners in one process. `integral server start
--component <name>` runs one component so the four can instead be operated as
separate processes. The component boundaries and ports are the same in both
modes.

The optional main configuration file is `<INTEGRAL_HOME>/config/integral.toml`. It uses a
strict TOML schema for server ports, runner image and limits, restored context,
and logging. Environment port variables override file values. Non-secret
connection records live under `<INTEGRAL_HOME>/config/connections/`; credentials
never belong in configuration files.

Phase 1 excludes Discord, Slack, multiple users, rooms, channels, research
workflows, ambient or unconfigured host directories, worker memory, actions,
approvals, trust, budgets, remote access, and service installation. It includes
two explicit host-resource connections: governed Git repositories and durable
writable stores. Pi may create Integral-owned backing data; the operator may
connect an existing bare repository or host directory. Pi creation tools and
the connection CLI both require a validated mount path below Pi's home and
commit resource creation plus mounting as one operation. Nothing on the host
becomes ambient merely because Pi requests a path.

Every governed repository has a stable identity, lifecycle revision, canonical
branch, ownership (`integral` or `operator`), and a mount path selected by the
actor adding it. Every active repository appears as an isolated checkout in
every interactive and scheduled Pi run. Pi
works with ordinary Git commits, while `repo_push` transfers an inert bundle to
trusted host code for quarantine, object and tree validation, and a serialized
compare-and-swap fast-forward. The canonical repository and its host path never
enter the container, and trusted host code never runs Git against Pi-writable
repository metadata.

Pi receives authenticated tools to list, create, attach, push, soft-delete, and
restore repositories. Soft deletion removes current and future access but keeps
canonical history and a tombstone; permanent purge is outside Phase 1. A run
that ends with unlanded work gets a bounded-lifetime recovery ref assembled
without trusting its `.git` directory. Concurrent runs resolve canonical
movement by fetching, rebasing, and retrying; Integral never merges their work.

A durable store is a directly writable host directory, not a Git landing
surface. Every active store is bind-mounted at its recorded path in
every Pi run, so acknowledged writes outlive temporary homes and containers.
Integral treats its contents as inert bytes: it never parses, executes, or runs
Git against them. A shared advisory lock helper coordinates cooperating runs.
Integral-owned stores receive bounded snapshots after changed runs and on a
daily sweep; operator-owned directories remain under the operator's backup and
recovery policy. Store lifecycle operations are authenticated and revisioned,
and deletion is soft: data, snapshots, and a tombstone remain while access is
removed.

Every Pi container lifetime is a run. Integral keeps a host-attested record of
interactive runs and isolated scheduled-task attempts under the deployment data
directory. Each agent environment receives a curated, read-only view at
`$HOME/history`: `runs` is a stable snapshot of earlier finalized records, while
`current` is a live projection of the active run. The view is execution
evidence, not writable worker storage: it excludes credentials and host
control-plane state and never exposes the durable archive itself. Each record
includes ordered activity, objective failure and correction signals,
provider-reported token and cache usage, timing, and available outcome evidence
so an agent can inspect what worked, what did not, and what it cost.

Host persistence includes configuration, connection credentials, the gateway
CA, process locks, the conversation record, its message queue, schedule
definitions and their Git-backed history, scheduled occurrences, the task
queue, execution history, the completion outbox, governed repository metadata,
Integral-owned canonical repositories, durable store metadata and backing
directories, store snapshots, tombstones, and recovery refs. Control records
remain separate from resource content. Queued input, scheduled work, resource
lifecycle state, landed repository history, and acknowledged Integral-owned
store writes must survive terminal and server loss. The schedule repository
contains definition revisions only; occurrence state, task results, attempts,
credentials, and temporary session identity do not belong in it.

External access uses the connection CLI vocabulary inherited from the source
project. Phase 1 supports catalog model providers, GitHub API and Git smart HTTP
access, generic HTTP endpoints, remote MCP servers, governed existing bare host
repositories, and existing writable host-store directories. Network connections
use OAuth, device-code, key, or no authentication; host resources use no
credential. It
supports `connection catalog`, guided and explicit `connection add`,
`connection ls`, and `connection rm`. It does not expose a separate credential
or auth CLI.

integral has no grant or revoke concept. In this single-user system, every active
connection is available to Pi automatically. The gateway still defaults to
deny and permits only the exact network access described by active connections.

The normative Phase 1 behavior specifications are organized under
[`behavior/`](behavior/README.md).
