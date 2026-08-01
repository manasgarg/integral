# rr TypeScript Reimplementation — Phase 1

Phase 1 provides one local user with a terminal conversation backed by Pi in a
locked-down Docker container. A TypeScript host process owns the CLI, container
lifecycle, external connections, credentials, and an HTTP(S) gateway. The
container has no direct internet access and never receives a real credential.

The package and binary are both named `rr`. The server and terminal client are
separate foreground processes. Each `$RR_HOME` owns exactly one durable logical
conversation and message queue. Any number of `rr talk` processes may attach to
it simultaneously; they see the same ordered messages, replies, queue, and Pi
session state. Closing a terminal only detaches that view. Multiple rr
deployments may run on one machine when they use different `$RR_HOME` roots and
different gateway ports.

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

rr has no grant or revoke concept. In this single-user system, every active
connection is available to Pi automatically. The gateway still defaults to
deny and permits only the exact network access described by active connections.

The normative Phase 1 behavior specifications are organized under
[`behavior/`](behavior/README.md).
