# rr TypeScript Reimplementation — Phase 1

Phase 1 provides one local user with a terminal conversation backed by Pi in a
locked-down Docker container. A TypeScript host process owns the CLI, container
lifecycle, model connections, credentials, and an HTTP(S) gateway. The
container has no direct internet access and never receives a real model
credential.

The package and binary are both named `rr`. The server and terminal client are
separate foreground processes, one chat may be active at a time, and
conversation state exists only for the lifetime of `rr talk`.

Phase 1 excludes Discord, Slack, multiple users, rooms, channels, research
workflows, tasks, queues, scheduling, background dispatch, host-managed worker
storage, durable chat history, memory, actions, approvals, trust, budgets, MCP,
email, non-model connections, arbitrary connection declarations, connection
grants, remote access, and service installation.

Minimal host persistence is limited to configuration, model credentials, the
gateway CA, and process locks. These are control-plane material rather than
worker storage.

Model authentication uses the connection CLI vocabulary inherited from the
source project. Phase 1 supports `connection catalog`, guided and explicit
`connection add`, `connection ls`, and `connection rm`. It does not expose a
separate credential or auth CLI.

The normative Phase 1 behavior specifications are organized under
[`behavior/`](behavior/README.md).
