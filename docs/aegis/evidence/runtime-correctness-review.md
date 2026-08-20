# Runtime Correctness Review

Date: 2026-08-15  
Scope: complete current working tree (`BASE_SHA: none`, `HEAD: WORKTREE`)  
Review mode: advisory, findings first

## Critical findings

### 1. The shipped client bundle is not a valid DSH Web client module

`tsdown.config.ts:17-23` builds the client as ordinary browser ESM. The generated `lib/client.js:1-2` begins with static `import` statements instead of registering a factory through `window.__ModuleLoader__.load({ id, factory })`.

The installed DSH rc.5 client-module contract requires that registration handoff (`/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh-client-modules/lib/types/client/manifest.d.ts:9-16,100-118`). A working installed third-party bundle uses the same loader contract under `$DSH_HOME/profiles/web/node_modules/`.

Impact: the activity projection, activity card, and Settings/Doctor UI cannot register from the packaged artifact even though their TypeScript and component tests pass.

Classification: **Implementation Drift — scope: architecture and requirements**.

### 2. Durable activity can still persist and display credentials

The current heuristic string redaction at `src/events.ts:72-77,92-100` does not cover common credential forms such as `AWS_SECRET_ACCESS_KEY=...`, whitespace-separated `GH_TOKEN ...`, compound/camel-case keys such as `accessToken` and `clientSecret`, or PEM private-key bodies. Structured key redaction at `src/events.ts:64,105-128` likewise does not cover every compound credential key.

Claude tool inputs/results and errors flow into durable activity at `src/supervisor.ts:383-401,472-481,522-547`; permission inputs/reasons are persisted through `src/permission.ts:35-37,79-102`; persisted details render at `src/client/ClaudeActivity.tsx:49-54`.

Impact: command lines, headers, `.env` output, file contents, hook output, or error prose can place credentials in the durable DSH session log and UI despite the no-credential-persistence contract.

Classification: **Implementation Drift — scope: requirements and security architecture**.

## Important findings

### 3. Cancellation can leave submitted prompts queued or the session permanently interrupting

The prompt UUID is created and submitted at `src/supervisor.ts:93,213-253`, but `src/supervisor.ts:501-520` ignores the Agent SDK interrupt receipt. SDK 0.3.233 documents that UUIDs returned in `still_queued` will run unless cancelled. The implementation also has no post-interrupt quiescence deadline: if `query.interrupt()` resolves but no result arrives, the entry stays `interrupting` and the process/session remains blocked. The test supplies a result manually at `test/supervisor.test.ts:205-217`, so it does not exercise the hung case.

Impact: a cancelled prompt can execute invisibly later, alter Claude context, or leave an owned process indefinitely live.

### 4. Concurrent first turns can create duplicate processes and exceed the process cap

At `src/supervisor.ts:188-192`, a missing entry causes an `await this.#makeRoom()` before the new entry is inserted. Two concurrent first requests for the same session can both observe no entry, both create a query/process, and then overwrite one another in the map. The same race can pass the global capacity check concurrently and exceed `maxProcesses`.

No concurrent `runTurn()` regression covers this path.

### 5. Subagent prose can be emitted as top-level assistant output

`src/sdk-messages.ts:49-63,174-187` does not preserve `parent_tool_use_id` for assistant text, thinking, or partial text/thinking deltas. `src/supervisor.ts:359-380` therefore streams/persists all normalized text as main-agent content.

Impact: internal subagent prose can leak into or duplicate the main DSH assistant reply. `test/sdk-messages.test.ts:19-37` has no nested text/thinking fixture.

### 6. Session append failures can wedge turns and leak ownership

The initial activity append occurs after the entry is marked active at `src/supervisor.ts:226-253`. If that append rejects, the entry can remain active with a live query/process. During pumping, activity/session append rejection can escape `#handleMessage` (`src/supervisor.ts:329-339`) and then make `#handleDisconnect` reject again before failing the consumer output (`src/supervisor.ts:522-547`).

Tests use session append implementations that never reject.

### 7. Initialization and Doctor probes have no liveness deadline

The query pump at `src/supervisor.ts:308-325` has no initialization timeout. A CLI/query that yields neither init nor result can leave the DSH turn pending indefinitely.

The Web Doctor calls probes without an AbortSignal at `src/doctor-routes.ts:52-55`; subprocess probe flow at `src/executable.ts:99-117,187-205` has no timeout. A wedged CLI can leave the HTTP request, Settings button, and probe process pending indefinitely.

### 8. Forced SDK kills are weakened into another graceful termination window

`src/spawn.ts:65-69` ignores the signal supplied to `kill()`. SDK 0.3.233 explicitly escalates to `kill('SIGKILL')` after its own grace period; this wrapper turns that into the generic DSH `terminate()` escalation, adding another grace interval during which cancelled code can continue.

`test/spawn.test.ts:47-53` checks only that `terminate()` was called, not force-kill timing/semantics.

### 9. Real SDK system messages can be silently dropped, while malformed initialization does not fail loud

Unhandled system subtypes return an empty list at `src/sdk-messages.ts:103-171`, silently losing mirror/background-task/reset/worker lifecycle and error evidence rather than emitting a bounded unknown activity. A malformed init becomes `unknown` at `src/sdk-messages.ts:105-112`; `src/supervisor.ts:414-423` records it as a warning and continues rather than terminating the affected process.

This contradicts the fail-loud malformed-protocol requirement. There are no malformed-init or unknown-system fixtures.

### 10. Event vocabulary registration depends on an unsupported rc.6 implementation detail

`src/events.ts:79-84` mutates `KNOWN_SESSION_EVENT_TYPES`. The installed rc.5 public declaration exposes this as `ReadonlySet<string>` and documents downstream registration as deferred. The implementation therefore relies on runtime mutability rather than a supported rc.5 public seam.

No vocabulary-install/rc.5 compatibility test covers this activation path.

### 11. A missing executable prevents Web Doctor from being registered

`src/index.ts:34-41` resolves Claude eagerly and aborts plugin activation on failure. Doctor registration happens later at `src/index.ts:62-64`.

Impact: the principal missing/misconfigured-executable repair surface is unreachable precisely when it is needed.

### 12. Doctor compatibility and privacy contracts are incomplete

`src/doctor-routes.ts:56-65` marks handshake `ok` merely when any supervisor snapshot contains a Claude session ID; this is not a compatibility handshake or feature check for the executable being diagnosed. `src/executable.ts:162-206` performs no SDK/CLI feature checks.

The same route returns the entire supervisor snapshot, including DSH and Claude session IDs, cwd, model, last-used timestamp, and PID (`src/supervisor.ts:53-60,172-181`), despite the documented process-count/coarse-diagnostic allowlist. No Doctor-route privacy/security test exists.

### 13. Multi-step turns collide in the client projection

`src/events.ts:178-192` resets `nextOrdinal` to zero on every `step/start`. `src/client/conversation.ts:37-45` maps every ordinal-zero activity in a turn to the same `id: turn-${turn}` with role `start`.

A later DSH step in the same turn can therefore issue a duplicate start for an existing projection context. `test/client-conversation.test.tsx:42-52` covers only a single step.

### 14. Managed preset upgrade/install/remove is neither version-aware nor transactional

`src/preset-installer.ts:62-87` recognizes only absent files or files byte-identical to the current package. A legitimate prior package-managed version is classified as a user modification and blocks activation/uninstall.

Validation and mutation are also interleaved. A second-file conflict can leave a partial install or delete the first managed file before removal fails. `test/preset-installer.test.ts:28-64` has no known-prior-version or second-file-conflict ordering case.

### 15. Host default model configuration is ineffective

Host configuration records `defaultModel` at `src/index.ts:42-47`, but `src/preset-route.ts:11-16` always supplies the request model `default`. `src/supervisor.ts:207` therefore does not fall back to the configured host default during normal routed requests.

No route/index test covers this documented configuration.

### 16. Agent disposal does not await or observe process-tree cleanup

The `agent/disposed` listener at `src/index.ts:58-60` discards `disposeSession()`. Teardown therefore neither waits for the managed process tree to exit nor observes cleanup rejection.

### 17. Usage/accounting has a durable-schema and completeness mismatch

`src/sdk-messages.ts:36-46` combines per-turn main-agent-only `usage` with the SDK's cumulative `total_cost_usd`, omits cumulative `modelUsage` for subagents/internal calls, and exposes the renamed `cumulativeCostUsd` field. The authoritative durable schema still specifies `costUsd` at `docs/aegis/spec/2026-08-15-dsh-claude-spec.md:209-215`.

This needs an explicit schema/baseline decision and defined turn-versus-query accounting semantics, not an unrecorded persisted-schema change. The fixture covers only one result.

### 18. rc.5 and live product acceptance remain unverified

All DSH development/type dependencies are rc.6 at `package.json:77-93`, while the product claims rc.5 compatibility and most peer ranges are unrestricted (`package.json:57-73`). There is no rc.5 compile/load lane.

The authoritative acceptance matrix requires native-session coexistence, a live Claude turn, approval allow/deny, cancellation with no orphan, refresh/restart resume, and idle eviction/resume (`docs/aegis/spec/2026-08-15-dsh-claude-spec.md:315-331`). The evidence record remains empty at `docs/aegis/work/2026-08-15-dsh-claude/90-evidence.md:1-3`, and the linked GUI Doctor endpoint was observed returning 404.

Classification: **Implementation Drift / evidence insufficiency — scope: both**.

## Minor findings

### 19. Task notification terminal states are over-normalized

`src/sdk-messages.ts:149-155` maps every task notification status except `failed` to `completed`; stopped/cancelled tasks can appear successful.

### 20. Authentication status overstates signed-out certainty

`src/executable.ts:149-156` treats any valid JSON without `loggedIn: true` as signed out instead of unknown.

### 21. Host executable configuration accepts relative paths

`src/executable.ts:66-76` accepts relative configured values despite the absolute-path contract and the CLI resolver's stricter behavior.

### 22. CLI missing-executable Doctor output omits diagnostic detail

`src/bin.ts:47-52` omits searched candidates and repair guidance.

### 23. Failed Doctor refresh retains stale successful rows

`src/client/ClaudeCodeSettings.tsx:28-37` clears the error but not the prior report, so stale rows continue rendering at `src/client/ClaudeCodeSettings.tsx:45-68` beside the new failure.

### 24. Idle timeout can overflow Node's timer range

`src/index.ts:26-31` sets no maximum and `src/supervisor.ts:546-553` passes the value directly to `setTimeout`. Values above Node's 32-bit timer maximum can schedule near-immediate eviction.

### 25. Typecheck emits generated artifacts beside source

`tsconfig.json:11-20` enables declaration/source-map emission without `noEmit` or an `outDir`, and `package.json:14-16` runs it. The working tree consequently contains source-adjacent `.js`, `.d.ts`, and map files.

### 26. Link/package build lifecycle is manually enforced rather than self-enforcing

Package exports and bin target ignored `lib/` artifacts (`package.json:7-10,18-36`; `.gitignore:2`), with no `prepare` or `prepack` lifecycle (`package.json:12-16`). DSH `plugin add` does not build linked packages. The documented workflow does run `pnpm check` before linking, so this is packaging fragility rather than a blocker for the documented checkout flow; an artifact/entrypoint regression test or lifecycle hook would make it self-enforcing.

## Verification evidence

Latest stable review snapshot:

- `pnpm check`: passed.
- Vitest: 9 files, 49 tests passed.
- Host and Client bundles built.
- Package contents were inspectable with `pnpm pack`.
- The built client artifact remains ordinary ESM and therefore fails the DSH client-module handoff contract.
- The currently linked GUI did not substantiate activation; `/plugins/dsh-claude/doctor` returned HTTP 404 during review.

Review-time verification regenerated/refreshed ignored `lib/` output and source-adjacent generated `.js`, `.d.ts`, and map files. No authored TypeScript/TSX, configuration, preset, or documentation source was intentionally changed by verification. Because the repository has no commit baseline and all project files are untracked, generated outputs were not reverted to avoid overwriting unknown prior state.

## Merge-readiness recommendation

**Not merge-ready.**

The client bundle format and durable credential-persistence risk are release blockers. Before merge, also resolve the cancellation/queued-message lifecycle, concurrent-entry race, append-failure containment, initialization/Doctor deadlines, malformed/unknown SDK handling, rc.5 event-vocabulary contract, Doctor privacy, multi-step projection identity, transactional/versioned preset behavior, teardown awaiting, model configuration, and durable usage schema.

After those fixes, rerun and record the complete rc.5 linked-profile acceptance matrix, including native/Claude coexistence, real Web client registration, live Claude streaming, approval allow/deny, cancellation with no queued/orphan work, refresh/restart/idle resume, Doctor missing-executable behavior, and credential-leak probes.
