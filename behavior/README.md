# Phase 1 behaviors

This directory contains the normative, test-case-oriented behavior
specifications for Phase 1.

- [`cli.md`](cli.md) — command discovery and version reporting
- [`connection.md`](connection.md) — model-provider discovery, setup, and credentials
- [`server.md`](server.md) — foreground server lifecycle
- [`gateway.md`](gateway.md) — health, session identity, and governed egress
- [`container.md`](container.md) — Pi provisioning, isolation, and RPC lifecycle
- [`chat.md`](chat.md) — terminal interaction and conversation lifecycle
- [`failure.md`](failure.md) — cross-cutting failure handling and cleanup

Behavior formatting and ID rules are defined in [`AGENTS.md`](../AGENTS.md).

## Retired IDs

None under the current opaque-ID scheme. All sequential IDs used before the
opaque-ID migration are permanently retired and must not be assigned again.
