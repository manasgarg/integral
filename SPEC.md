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
`INTEGRAL_GATEWAY_PORT`, `INTEGRAL_COORDINATOR_PORT`, and `INTEGRAL_RUNNER_PORT` select distinct
component ports and default to `7310`, `7311`, and `7312`. `INTEGRAL_LOG_LEVEL` and
`INTEGRAL_LOG_FORMAT` override logging configuration. All integral-specific variables are
resolved once when a process starts. The Pi container does not inherit them or
the rest of the host shell environment.

The server consists of three components: the coordinator owns terminal clients
and the durable conversation queue, the runner owns Pi containers, and the
gateway owns governed egress and credential injection. `integral server start` runs
all three listeners in one process. `integral server start --component <name>` runs
one component so the three can instead be operated as separate processes. The
component boundaries and ports are the same in both modes.

The optional main configuration file is `<INTEGRAL_HOME>/config/integral.toml`. It uses a
strict TOML schema for server ports, runner image and limits, restored context,
and logging. Environment port variables override file values. Non-secret
connection records live under `<INTEGRAL_HOME>/config/connections/`; credentials
never belong in configuration files.

Phase 1 excludes Discord, Slack, multiple users, rooms, channels, research
workflows, task scheduling, recurring work, host-managed worker storage, worker
memory, actions, approvals, trust, budgets, email, host-resource connections,
remote access, and service installation.

Host persistence is limited to configuration, connection credentials, the
gateway CA, process locks, the conversation record, and its message queue. The
conversation and queue are control-plane state rather than worker-managed
storage. Queued input must survive terminal and server loss.

External access uses the connection CLI vocabulary inherited from the source
project. Phase 1 supports catalog model providers, generic HTTP endpoints, and
remote MCP servers with OAuth, device-code, key, or no authentication. It
supports `connection catalog`, guided and explicit `connection add`,
`connection ls`, and `connection rm`. It does not expose a separate credential
or auth CLI.

integral has no grant or revoke concept. In this single-user system, every active
connection is available to Pi automatically. The gateway still defaults to
deny and permits only the exact network access described by active connections.

The normative Phase 1 behavior specifications are organized under
[`behavior/`](behavior/README.md).
