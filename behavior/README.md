# Phase 1 behaviors

This directory contains the normative, test-case-oriented behavior
specifications for Phase 1.

- [`cli.md`](cli.md) — command discovery and version reporting
- [`environment.md`](environment.md) — deployment selection and container environment
- [`config.md`](config.md) — configuration files, validation, and options
- [`logging.md`](logging.md) — component diagnostics, structure, and redaction
- [`connection.md`](connection.md) — provider, service, and host-resource setup
- [`mcp.md`](mcp.md) — generalized remote and stdio MCP discovery, isolation, and tools
- [`repository.md`](repository.md) — agent-visible governed Git repositories
- [`store.md`](store.md) — durable writable host stores
- [`email.md`](email.md) — Gmail and Mailgun account capabilities and policy
- [`discord.md`](discord.md) — single-user Discord DM setup and conversation access
- [`server.md`](server.md) — combined and separate component lifecycle
- [`gateway.md`](gateway.md) — health, session identity, and governed egress
- [`container.md`](container.md) — Pi provisioning, isolation, and RPC lifecycle
- [`profile.md`](profile.md) — opaque repository mounted at Pi's native profile directory
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
- `REPO-EB7BFD7A` — deferred repository attachment after connection creation
- `STORE-B76FB6B3` — deferred store attachment after connection creation
- `CONNECTION-11EE2FC9` — attached a configured host resource in a separate CLI operation
- `PIPKG-32C46F41` — made Integral build and understand a special untrusted Pi runtime package
- `PIPKG-B67EF4A2` — refreshed a special Integral Pi runtime outside ordinary repository lifecycle
- `PIPKG-F8406EF8` — built and activated special Integral Pi runtime artifacts
- `PIPKG-E98253F5` — gave Pi a separate source checkout for a special runtime artifact
- `PIPKG-FDA7D1DD` — routed local Integral Pi development through the retired artifact pipeline
- `SKILL-9CF01380` — specified skill layout inside profile content owned by Pi
- `SKILL-608366EB` — specified Pi's loading behavior for profile skills
- `SKILL-F9858AF9` — specified how Pi should author skills
- `SKILL-C7C81A86` — specified how Pi should version related untrusted code
- `SKILL-6D9299C4` — duplicated ordinary repository recovery for skill-specific work
- `JOURNAL-4A436073` — specified journal content and lifecycle owned by Pi
- `PREF-DEF97F16` — specified user-preference behavior owned by Pi
- `LEARN-8073E4CC` — specified a self-improvement loop owned by Pi
- `DEV-79F36207` — specified software-development behavior owned by Pi
- `PROFILE-97C5C7BA` — duplicated the ordinary repository lifecycle for Pi's profile
