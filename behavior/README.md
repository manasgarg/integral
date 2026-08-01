# Phase 1 behaviors

This directory contains the normative, test-case-oriented behavior
specifications for Phase 1.

- [`cli.md`](cli.md) — command discovery and version reporting
- [`connection.md`](connection.md) — provider, HTTP, and MCP connection setup
- [`server.md`](server.md) — foreground server lifecycle
- [`gateway.md`](gateway.md) — health, session identity, and governed egress
- [`container.md`](container.md) — Pi provisioning, isolation, and RPC lifecycle
- [`chat.md`](chat.md) — terminal interaction and conversation lifecycle
- [`queue.md`](queue.md) — durable message ordering, editing, and deletion
- [`failure.md`](failure.md) — cross-cutting failure handling and cleanup

Behavior formatting and ID rules are defined in [`AGENTS.md`](../AGENTS.md).

## Retired IDs

All sequential IDs used before the opaque-ID migration are permanently retired
and must not be assigned again. Retired opaque IDs:

- `CONNECTION-04D019E7` — rejected generic connections before they entered scope
- `BOX-64D9E7BA` — described the message queue as in-memory container state
- `CHAT-A2EAD40A` — made terminal exit destroy the shared conversation
- `CHAT-7C6DE818` — made each terminal invocation start a blank conversation
