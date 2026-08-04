# Phase 1 behaviors

This directory contains the normative, test-case-oriented behavior
specifications for Phase 1.

- [`cli.md`](cli.md) — command discovery and version reporting
- [`environment.md`](environment.md) — deployment selection and container environment
- [`config.md`](config.md) — configuration files, validation, and options
- [`logging.md`](logging.md) — component diagnostics, structure, and redaction
- [`connection.md`](connection.md) — provider, HTTP, and MCP connection setup
- [`email.md`](email.md) — Gmail and Mailgun account capabilities and policy
- [`server.md`](server.md) — combined and separate component lifecycle
- [`gateway.md`](gateway.md) — health, session identity, and governed egress
- [`container.md`](container.md) — Pi provisioning, isolation, and RPC lifecycle
- [`chat.md`](chat.md) — terminal interaction and conversation lifecycle
- [`queue.md`](queue.md) — durable message ordering, editing, and deletion
- [`schedule.md`](schedule.md) — schedule management and isolated task execution
- [`run.md`](run.md) — durable run records and agent-visible execution history
- [`failure.md`](failure.md) — cross-cutting failure handling and cleanup

Behavior formatting and ID rules are defined in [`AGENTS.md`](../AGENTS.md).

## Retired IDs

All sequential IDs used before the opaque-ID migration are permanently retired
and must not be assigned again. Retired opaque IDs:

- `CONNECTION-04D019E7` — rejected generic connections before they entered scope
- `BOX-64D9E7BA` — described the message queue as in-memory container state
- `CHAT-A2EAD40A` — made terminal exit destroy the shared conversation
- `CHAT-7C6DE818` — made each terminal invocation start a blank conversation
- `CONFIG-9D37B5A0` — moved logging configuration into the logging behavior group
- `CONNECTION-B4E83C2D` — defaulted Anthropic to OAuth instead of asking the user
- `CONFIG-A5D19E72` — selected the model connection and model from the main configuration
