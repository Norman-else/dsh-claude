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

## TaskStartSnapshot — 2026-08-18 history replay repair

- Symptom: Claude finishes in about 8 seconds and DSH writes `assistant/message`, `step/end`, and `turn/end`, but the live Web view remains on `Deep diving`; after restart, history load fails on `claude-code/activity` as an unknown required event.
- Reproduction: create a linked-profile Claude session, complete a turn, restart/open the session; Host rc.5 rejects the custom event even though the linked checkout's rc.6 copy registered it.
- Root cause: the linked plugin imports the mutable event vocabulary from its checkout-local `@deepseek-ai/dsh-session` rc.6 instance, while the running App reads logs with a distinct Host rc.5 module instance.
- Change necessity: no configuration or refresh can make two module singletons share vocabulary. Decision: code-change.
- Fix boundary: resolve and mutate the running Host entrypoint's public `@deepseek-ai/dsh-session` export and add module-identity regression coverage. Keep published rc.6 packages for compilation because rc.5 is not available from npm; do not patch the installed DSH checkout.
- Verification target: existing corrupted sessions become readable after Host restart; a new Claude turn completes live and remains readable after a second restart; `PATH=/opt/homebrew/bin:$PATH pnpm check` passes.

## Checkpoint Update — 2026-08-18 history replay repair

- Completed: Host-relative vocabulary resolution is isolated in `src/event-vocabulary.ts`; client-safe event code no longer imports the checkout-local runtime singleton; the architecture baseline records the module-identity requirement.
- Direct evidence: after rebuilding and restarting DSH, formerly rejected session `session-74684850-1109-4521-9022-271815d37955` loaded 84 events including 30 Claude activities, 3 assistant messages, and 3 turn ends. A new `Hi` turn persisted its assistant reply and turn end.
- Regression evidence: `PATH=/opt/homebrew/bin:$PATH pnpm check` passed with 87 tests; the installed-Host integration test resolves and mutates `/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh-session/lib/index.js` rather than the linked checkout copy.
- Separate remaining issue: the DSH Web store can retain `running:true` after completion even though `session.list` reports false and the Host WebSocket emits a fresh `host/session-status` true-to-false edge. This behavior is owned by DSH client runtime; the plugin has no public write API for `Session.handleRunning`, so no duplicate status owner or private-API workaround was added.
- Workspace integrity: proof bundle generation succeeded, but workspace check remains red on three pre-existing unindexed evidence files (`2026-08-15-verification.md`, `runtime-correctness-review.md`, `security-lifecycle-review.md`); transient helper outputs were removed rather than retaining an invalid bundle.
- Next step: report the DSH client live-status defect upstream or fix it in DSH core; use page refresh as the bounded recovery path meanwhile.
