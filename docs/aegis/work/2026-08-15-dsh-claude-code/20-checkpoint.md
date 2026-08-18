# Implement dsh-claude-code - Checkpoint

- Task ID: 2026-08-15-dsh-claude-code
- Current todo: Scaffold package
- Active slice: Plan Task 1
- Blocked on: none
- Next step: Create package metadata and compile empty Host/Client entries

## Checkpoint Update

- Current todo: Define durable Claude events and safe normalization
- Active slice: Plan Task 2
- Completed todos:
- Task 1: package scaffold compiles and builds Host/Client/CLI/preset route outputs
- Evidence refs:
- pnpm typecheck; pnpm build; test/events.test.ts
- Blocked on: none
- Next step: Complete event integration and implement executable/Doctor/process adapter

## Checkpoint Update

- Current todo: Implement DSH adapter, route, and managed preset
- Active slice: Plan Tasks 6-7
- Completed todos:
- Tasks 2-5: durable events, redaction, executable Doctor, managed process adapter, permission bridge, SDK message normalization, and long-lived supervisor
- Evidence refs:
- 31 Vitest regressions; pnpm typecheck
- Blocked on: none
- Next step: Implement StreamChunk adapter, host activation, and managed Agent Preset install

## Checkpoint Update

- Current todo: Complete linked-profile verification and independent review
- Active slice: Plan Task 10
- Completed todos:
- Tasks 6-9: DSH adapter/provider with zero outer retries, preset-scoped routing, no-clobber managed preset installer, Host activation/Doctor route, CLI, native client activity cards, bilingual Settings Doctor, package/runbook documentation
- Hardening: abort-before-submit race closed; permission activity participates in outcome-unknown classification; embedded string credentials redacted; SDK executable command pinned; cumulative query cost named explicitly
- Evidence refs:
- 49 Vitest regressions; pnpm typecheck/build/pack; safe CLI Doctor; composed Web profile includes llm-claude-code-cli; live Agent SDK handshake/result succeeded; link install and managed preset install succeeded
- Blocked on: current DSH Host predates profile link and requires Host restart before existing 56454 URL can expose the new route/client
- Next step: Resolve independent review findings, restart/reload the existing Host, verify Doctor route and GUI contribution

## Checkpoint Update

- Current todo: Finalize after independent review and linked-profile verification
- Active slice: Plan Task 10 (complete pending Host restart)
- Completed todos:
- All review blockers resolved: client bundle now uses DSH ModuleLoader format; durable credential redaction expanded; cancellation/concurrency/protocol/Doctor/preset/adapter hardening complete
- Evidence refs:
- 62 Vitest regressions; pnpm typecheck/build/pack; safe CLI Doctor; live SDK handshake; profile composition valid; review documents recorded
- Blocked on: current DSH Host predates profile link and requires Host restart before existing 56454 URL can expose the new route/client
- Next step: Restart existing DSH Host and run live acceptance matrix (native coexistence, Claude turn, permission, cancel, resume, orphan check)

## Checkpoint Update

- Current todo: Complete live acceptance after Host restart
- Active slice: Plan Task 10 (only Host restart + live matrix remain)
- Completed todos:
- All review blockers and protocol findings resolved: result is_error classification, repeated init tolerance, assistant-text dedup, abort terminal-reason classification, terminal-reason diagnostics, signalAborted TS2367, embedded string credential redaction, cancel teardown with still_queued + bounded interrupt, admission-gate serialization, disconnect/append cleanup, init timeout, protocol-error termination, Doctor same-origin + privacy + missing-executable, exact executable spawn pin, extended env scrub, client ModuleLoader bundle format, preset-route model passthrough, disposal await
- Evidence refs:
- 66 Vitest regressions; pnpm typecheck/build/pack; safe CLI Doctor; live SDK handshake; profile composition valid; review documents recorded; four commits a4f5aa9..941128f
- Blocked on: current DSH Host predates profile link and requires Host restart before existing 56454 URL can expose the new route/client
- Next step: Restart existing DSH Host and run live acceptance matrix (native coexistence, Claude turn, permission, cancel, resume, orphan check)
