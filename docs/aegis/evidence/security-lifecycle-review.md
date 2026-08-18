# Adversarial Security and Lifecycle Review

Date: 2026-08-15

Authority: `docs/aegis/spec/2026-08-15-dsh-claude-code-spec.md`

Scope: all repository source, configuration, documentation, tests, generated/package surfaces where relevant, and exact installed public contracts in `node_modules` and the DSH rc.5 host. Advisory only; this review made no runtime/source changes.

## Current workspace state

- The repository has no commits yet; all repository files are currently untracked on `master`.
- The workspace changed concurrently during review. This document reflects the final re-read state, including current embedded-string redaction and the expanded supervisor tests.
- A concurrent reviewer observed the current automated suite passing 43/43 tests. Existing evidence also states typecheck/build/pack pass.
- The Web profile link points to this checkout, but the existing host has not restarted. The linked Doctor route currently returns 404, so link success is not activation evidence.
- `docs/aegis/work/2026-08-15-dsh-claude-code/90-evidence.md:1-3` explicitly records that no final integration evidence exists.
- Native DSH behavior being unaffected, actual linked-host activation, cancellation quiescence, and restart resume remain unverified acceptance requirements.
- No kernel confinement is implemented or claimed; the repository states this boundary accurately at `README.md:63-74`.

# Findings

## Critical

### C1. The linked checkout loads DSH rc.6 peers beside the rc.5 host

The linked Web-profile package resolves DSH imports from this checkout's `node_modules`, not from the installed host:

- Wildcard peer declarations: `package.json:57-73`.
- Development/runtime resolution contains DSH rc.6: `package.json:80-93`.
- The installed host session package is rc.5: `/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh-session/package.json:4`.
- The plugin mutates its imported session-event singleton: `src/events.ts:79-85`.
- Host persistence checks its own `KNOWN_SESSION_EVENT_TYPES`: `/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js:1119`.

The installed profile link points directly to this checkout, and module resolution from `lib/index.mjs` selected the checkout's rc.6 packages. Consequently, the plugin can extend an rc.6 event set while the rc.5 host persistence layer validates against a different set. Custom events may append during a live process but fail host restart or rehydration.

This invalidates the rc.5 compatibility claim in `README.md:20` and means successful linking, typechecking, and packaging do not establish activation or durable resume.

Missing evidence/tests:

- Build and execute against exact rc.5 peers.
- Append and reload both custom events through the installed host.
- Restart the host and resume a real Claude session.

### C2. Cancellation does not guarantee stopped work or process-tree quiescence

Current code correctly rejects a pre-aborted request and rechecks cancellation before submission, but cancellation after submission remains unsafe:

- Interrupt only, with no timeout or forced termination: `src/supervisor.ts:501-520`.
- The SDK contract says `still_queued` UUIDs will run unless cancelled: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2365-2372,3737-3747`.
- The interrupt receipt is ignored.
- Prompt UUID is generated and sent: `src/supervisor.ts:213-254`.
- Result normalization drops `user_message_uuid`: `src/sdk-messages.ts:194-206`.
- Results settle the active turn without prompt/session correlation: `src/supervisor.ts:435-498`.
- The adapter propagates abort as an exception instead of emitting the required `finish: aborted`: `src/adapter.ts:125-142`.

A queued cancelled prompt may execute after DSH reports cancellation. A late result can be ignored or attributed to a later request. If `interrupt()` resolves but no terminal result arrives, the entry remains `interrupting` indefinitely.

The existing test manually injects a result after interrupt and therefore masks this defect: `test/supervisor.test.ts:205-217`.

Missing tests:

- `still_queued` receipt handling.
- Interrupt success with no result.
- Hung interrupt and forced tree termination/join.
- Late cancelled result and result UUID mismatch.
- Exact aborted `StreamChunk` sequence.

## Important

### I1. Concurrent turns can create duplicate or untracked queries and exceed the process cap

`runTurn()` reads the session map, yields in `#makeRoom()`, then creates and inserts the entry:

- `src/supervisor.ts:184-193`.
- Unlocked capacity and eviction: `src/supervisor.ts:272-280`.

Two first requests for the same session can both create queries; the later `Map.set` hides the earlier query. Different sessions can both observe available capacity and exceed `maxProcesses`.

Existing entries also race because the busy check occurs before an awaited model change: `src/supervisor.ts:197-226`.

This contradicts the one-query, one-active-turn, and process-cap claims at `README.md:78-80`.

Missing tests: concurrent same-session creation, cross-session creation at cap, concurrent model changes, all-active cap refusal, and true multi-entry LRU ordering.

### I2. Disconnect and persistence-failure paths can lose process ownership

Pump errors route to disconnect handling:

- Pump: `src/supervisor.ts:329-339`.
- Disconnect deletes the entry without closing the query, aborting lifetime, terminating, or joining the process tree: `src/supervisor.ts:522-548`.
- Full cleanup exists only in `#disposeEntry`: `src/supervisor.ts:561-576`.

A protocol-normalization error, activity persistence failure, or other message-handling exception can therefore remove the only supervisor reference while Claude or descendants remain alive.

Completion and disconnect also await durable activity appends before settling output and clearing state:

- Completion: `src/supervisor.ts:435-498`.
- Disconnect: `src/supervisor.ts:522-548`.

If `session.append` rejects, output can remain unsettled and cleanup can fail recursively. Disposal additionally ignores whether `waitForExit()` returned `false`, so shutdown can resolve without proving tree quiescence: `src/supervisor.ts:569-575`.

Missing tests: root exit with a surviving descendant, handler failure with kill assertion, `session.append` failures at start/completion/disconnect, and `waitForExit(false)`.

### I3. Malformed, stale, or cross-session SDK messages fail open

Protocol validation remains permissive:

- Malformed assistant/user payloads are silently discarded: `src/sdk-messages.ts:49-101`.
- Malformed init becomes an `unknown` warning: `src/sdk-messages.ts:103-112`.
- Unknown system subtypes are silently ignored: `src/sdk-messages.ts:168-171`.
- Unknown top-level messages become warnings: `src/sdk-messages.ts:218`.
- Malformed results accept an empty session ID: `src/sdk-messages.ts:194-206`.
- Unknown messages are persisted and execution continues: `src/supervisor.ts:392-423`.

The supervisor does not validate result session ID or prompt UUID before completion. It also accepts duplicate or unexpected init messages. This contradicts the required terminate-affected-process behavior for malformed SDK/CLI messages.

Missing tests: malformed known message types, null/hostile envelopes, result before init, wrong session ID, stale result after cancellation, prompt UUID mismatch, duplicate init, and process termination after protocol fault.

### I4. Resume can silently rebind, with no initialization deadline

The persisted binding is passed to the SDK at `src/supervisor.ts:287-323`, but any later init unconditionally overwrites and persists the reported session ID and cwd at `src/supervisor.ts:342-351`.

There is no check that a resumed session initialized with the requested ID, no immutable-cwd verification, no initialization timeout, and no explicit persisted-session-missing classification. This risks silent context reset rather than the required explicit failure.

Missing tests: `options.resume`, resumed-ID equality, cwd mismatch, missing Claude session, duplicate init, initialization timeout, and timeout tree cleanup.

### I5. Doctor's same-origin check is DNS-rebinding vulnerable

`trustedRequest()`:

- Allows requests with no `Origin`: `src/doctor-routes.ts:8-20`.
- Compares `Origin` against attacker-controlled `Host`.
- Accepts a hostname resolving to loopback when Host and Origin match.

That is not a robust same-origin or host-authorization boundary. The Settings page automatically invokes Doctor on mount: `src/client/ClaudeCodeSettings.tsx:28-43`.

Missing tests: DNS-rebinding Host/Origin, absent Origin, unexpected fetch metadata, method handling, and non-loopback binding.

### I6. Doctor exposes substantially more process metadata than allowed

Doctor returns complete supervisor snapshots:

- Route: `src/doctor-routes.ts:56-65`.
- Snapshot includes DSH session ID, Claude session ID, cwd, model, state, last-used time, and PID: `src/supervisor.ts:53-61,172-181`.

The browser UI only needs the process count: `src/client/ClaudeCodeSettings.tsx:45-52`. This contradicts the allowlist in the authority and `README.md:99`.

### I7. Doctor probes are unbounded and browser redaction is incomplete

The route supplies no deadline or request abort signal:

- `src/doctor-routes.ts:48-67`.
- Probe execution awaits subprocess completion: `src/executable.ts:99-117,187-205`.

Repeated Doctor requests can accumulate hung local CLI probes.

The browser error boundary uses a much narrower redactor than durable events: `src/doctor-routes.ts:32-36`. It misses Bearer tokens, prefixed API keys, JSON credential fields, and URL userinfo. Authentication fields are copied from arbitrary CLI strings without enum or length validation at `src/executable.ts:149-156`.

Therefore the absolute never-returns-secrets claim at `README.md:99` is not enforced for unexpected or configured executables.

### I8. Missing executable prevents the GUI Doctor from diagnosing it

Activation order is visible at `src/index.ts:33-64`:

1. Install preset.
2. Resolve executable.
3. Register adapter and Doctor route.

If resolution fails, the preset may already exist while Doctor never registers. This violates the required missing-executable Doctor behavior and can leave a visible but unusable preset.

The handshake is not a compatibility probe: `src/executable.ts:181-206` leaves it `not-run`, while `src/doctor-routes.ts:56-57` marks it `ok` merely when any process has a Claude session ID.

### I9. Managed preset operations are non-transactional and not upgrade-safe

Installation validates and writes one file at a time: `src/preset-installer.ts:62-75`. Removal validates and deletes one file at a time: `src/preset-installer.ts:78-95`.

A conflict in the second file can leave a partial install or partial removal. Only byte equality with the current package is recognized, so a legitimate prior managed version blocks both upgrade and later removal.

The installer also merges into an existing foreign preset directory when its two filenames are absent. There is no ownership marker or directory/symlink validation.

Missing tests: second-file conflicts, rollback, prior managed version upgrade/removal, foreign files, symlinked directory/files, concurrent install/remove, and TOCTOU behavior.

### I10. Preset routing discards selected model aliases

The route spreads upstream configuration and then always overwrites the model at `src/preset-route.ts:12-16`. The packaged preset supplies no route configuration at `preset/agent.cordis.yml:3-4`.

Therefore upstream selection of `sonnet`, `opus`, or `haiku` becomes `default`, contradicting `README.md:10,52` and the authority's model-alias contract.

### I11. Route/native isolation is not enforced at the adapter boundary

The provider and model list are globally registered:

- `src/index.ts:54-57`.
- `src/adapter.ts:87-119`.

The adapter has no preset-membership or empty-conversation guard. Intended isolation depends on external UI and route scoping. There is no regression test proving that native sessions cannot select or switch to this provider, non-empty conversations cannot switch into Claude, native/auxiliary calls remain unaffected, or the preset route is the only entry point.

The adapter explicitly rejects auxiliary calls once they arrive at `src/adapter.ts:108-111`; isolation should prevent them from being routed here in the first place.

### I12. Ambient child-environment scrubbing is narrower than the security claim

The spawn wrapper correctly rejects an unexpected executable and uses DSH-managed argv/tree ownership at `src/spawn.ts:79-103`.

Environment filtering delegates to DSH's credential-shaped key pattern:

- `src/spawn.ts:14-22`.
- Installed pattern is only `/KEY|PASSWORD|SECRET|TOKEN/i`: `node_modules/@deepseek-ai/dsh-subprocess/lib/index.js:24-31`.

Opaque values in variables such as `AUTHORIZATION`, `COOKIE`, `DATABASE_URL`, `NETRC`, or other credential carriers can survive. Tests cover API-key/token/password and `DSH_*`, not these carriers: `test/spawn.test.ts:57-85`.

Current durable redaction is materially improved and covers embedded assignments, Bearer/prefixed/JWT tokens, URL userinfo, query secrets, summaries, and errors:

- `src/events.ts:72-166`.
- `test/events.test.ts:30-54`.

Accordingly, the stale blanket claim that arbitrary strings are persisted verbatim is not valid for the current workspace. The residual concern is unmatched secret formats, whole environment maps, and the separate Doctor boundary.

## Minor

### M1. Cumulative cost is presented as per-turn cost

The SDK documents `total_cost_usd` as cumulative across streaming-input turns at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:4580-4590`.

Normalization republishes each cumulative total as `costUsd` without delta calculation or labeling at `src/sdk-messages.ts:36-46`. This can overcount or misrepresent later turns. Authoritative `result.permission_denials` is also ignored.

### M2. Uninstall can orphan the managed preset

Activation installs the preset automatically at `src/index.ts:33-36`. Standard bundle removal removes only the Host row at `cordis.patch.yml:3-5`. Preset removal is a separate manual CLI action at `src/bin.ts:83-90`.

Removing the package first can leave a preset referencing a missing module. This is documented, so it is lifecycle fragility rather than silent deletion.

`INSTALL.md:43` also incorrectly expects zero child Claude processes after cancellation. A successfully interrupted, still-owned long-lived session process is legitimate; the check should assert no orphaned or still-executing cancelled work.

# Permission and security-boundary assessment

Current permission-callback behavior is fail-closed when the callback runs:

- Missing active owner denies: `src/permission.ts:65-74`.
- Pending activity is recorded before requesting approval: `src/permission.ts:76-93`.
- Only `allowed-once` grants: `src/permission.ts:39-58`.
- Approval or persistence exceptions deny: `src/permission.ts:104-128`.
- Permission evidence now marks the active turn as activity for outcome-unknown classification: `src/permission.ts:76`, `src/supervisor.ts:300-306`.
- Tests now cover permission-then-crash: `test/supervisor.test.ts:189-203`.

This should not be broadened into a claim of kernel confinement or universal approval of every Claude-owned execution. Local Claude rules and settings remain part of Claude's own permission behavior, and v0.1 intentionally provides no kernel workspace confinement.

# Missing verification and false assurances

- The test suite now includes improved redaction, pre-abort, and permission-evidence tests, but still lacks the races and real process-tree scenarios above.
- `package.json:12-16` has no package-contents verification despite the authority requiring it.
- Tests compile against rc.6 rather than the target host rc.5: `package.json:80-93`.
- `README.md:132` claims a minimal live smoke, but the repository contains fixture/unit tests only.
- The durable evidence record explicitly says none exists: `docs/aegis/work/2026-08-15-dsh-claude-code/90-evidence.md:1-3`.
- Profile linking succeeded, but the existing host has not restarted and the route remains 404. This is not activation, native-coexistence, cancellation, resume, or browser evidence.
- Native DSH behavior being unaffected remains an acceptance requirement, not an established result.
- No kernel confinement is implemented, and the repository correctly avoids claiming it: `README.md:63-74`.

# Conclusion

The package is not release-ready against the approved authority.

Positive current properties include fail-closed approval callbacks when invoked, materially improved durable event redaction, explicit executable pinning in the spawn wrapper, disabled outer model retries, and accurate documentation that no kernel confinement is provided.

Release-blocking gaps remain in exact-host package identity, cancellation, concurrent ownership, protocol validation, resume integrity, Doctor authorization/exposure, and managed preset lifecycle. The linked rc.5 host must be restarted and exercised only after these issues are addressed, with native-session coexistence and process-tree quiescence demonstrated using the exact installed public contracts.
