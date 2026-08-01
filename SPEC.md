# rr TypeScript Reimplementation — Phase 1

Phase 1 provides one local user with a terminal conversation backed by Pi in a
locked-down Docker container. A TypeScript host process owns the CLI, container
lifecycle, external connections, credentials, and an HTTP(S) gateway. The
container has no direct internet access and never receives a real credential.

The package and binary are both named `rr`. The server and terminal client are
separate foreground processes, one chat may be active per `$RR_HOME`, and
conversation state exists only for the lifetime of `rr talk`. Multiple rr
deployments may run on one machine when they use different `$RR_HOME` roots and
different gateway ports.

Phase 1 excludes Discord, Slack, multiple users, rooms, channels, research
workflows, tasks, queues, scheduling, background dispatch, host-managed worker
storage, durable chat history, memory, actions, approvals, trust, budgets,
email, host-resource connections, remote access, and service installation.

Minimal host persistence is limited to configuration, connection credentials,
the gateway CA, and process locks. These are control-plane material rather than
worker storage.

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
