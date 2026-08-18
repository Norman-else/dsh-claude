# dsh-claude-code Implementation Plan

Status: ready for execution
Date: 2026-08-15
Parent spec: `docs/aegis/spec/2026-08-15-dsh-claude-code-spec.md`

## Scope check

### Facts

- Target project is a new repository at `/Users/normanzuo/PersonalRepos/dsh-claude-code`.
- Installed DSH is `0.1.0-rc.5` and exposes public LLM adapter, agent request waterfall, session event extension, subprocess, approval, Agent Preset, client conversation projection, slots, Web server, and client-module bundle surfaces.
- Local Claude Code is `2.1.233` at `/Users/normanzuo/.local/bin/claude`.
- `@anthropic-ai/claude-agent-sdk@0.3.233` supports an explicit local executable, streaming input, partial messages, `canUseTool`, and custom process spawning.
- DSH Agent Presets are discovered from `$DSH_HOME/.agent-presets` without restart, but there is no public dynamic root-registration API.
- DSH's current process sandbox cannot add a separate Claude state root; v0.1 uses permission bridging and managed process cleanup without claiming kernel-level workspace confinement.

### Assumptions to verify during implementation

- A preset-scoped `agent/request` waterfall listener can replace the route for agents joined to that preset.
- Agent SDK streaming-input mode in `0.3.233` remains alive across multiple top-level result messages.
- The SDK's `spawnClaudeCodeProcess` contract can be satisfied by an EventEmitter wrapper around a DSH `SubprocessHandle`.
- The client `conversation.chat.turnTail` slot plus a `ConversationNodeDefinition` can render complete per-turn Claude activity without core UI changes.

### Unknowns with fail-loud handling

- Exact SDK message variants produced by the user's CLI configuration and plugins.
- Whether authentication status has a stable machine-readable command in CLI 2.1.233.
- Whether background Claude subagents continue after a top-level result. v0.1 ends ownership at the result and documents background continuation as unsupported.

### Requirement Ready Check

- Product behavior: approved.
- Ownership/source-of-truth: approved.
- Permission behavior: approved.
- Platform scope: macOS-first.
- Compatibility boundary: pure out-of-tree plugin; no DSH core edits.
- Security amendment: approved; permission bridge, no kernel sandbox claim.

### Ripple Signal Triage

- New public package/bundle surface: yes.
- New durable session event types: yes.
- New security/permission boundary: yes.
- New client projection and settings page: yes.
- Migration: no existing persisted plugin data.
- Retirement: no old plugin path; future keyed AgentFactory must replace, not layer beside, the bridge.

## TDD Route

- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Test posture: focused post-change regression with protocol fixtures plus local integration smoke
- Reason: no explicit strict TDD request; the work is a new integration whose external protocol requires implementation fixtures and runtime probes.
- Verification: Host and Client typechecks, Vitest suites, package build, package-contents check, linked-profile activation, Claude live smoke, permission smoke, cancellation, resume, and orphan-process check.

## Execution Route

- Decision: inline
- Evidence: one new package with tightly coupled Host, preset, protocol, and Client contracts; concurrent edits would collide in package metadata and shared event types.
- Fallback: delegate isolated review/research only; keep implementation ownership inline.
- User confirmation required: no — project path and design are explicitly approved.

## Compatibility boundary

- No changes under the installed DSH checkout or current Navi repository.
- Depend only on published DSH package exports and declared client entry points.
- The installed Web profile is changed only during the final link-install smoke.
- Automatic preset installation writes a tiny managed preset under `$DSH_HOME/.agent-presets/claude-code-cli`; it never overwrites a non-managed user preset.
- Uninstall leaves the managed preset as visibly broken unless the package CLI removes it; provide an idempotent uninstall command and document it.

## File map

### Package and build

- `package.json` — package exports, bundle/client metadata, scripts, dependencies, peer dependencies.
- `tsconfig.json` — Host build/typecheck.
- `tsconfig.client.json` — browser build/typecheck.
- `tsdown.config.ts` — Host and Client bundles.
- `vitest.config.ts` — tests.
- `cordis.patch.yml` — host plugin insertion.
- `.gitignore`, `LICENSE`, `README.md`, `INSTALL.md`, `AGENTS.md`.

### Host runtime

- `src/index.ts` — Cordis plugin entry, config, adapter registration, Web routes, preset installer.
- `src/constants.ts` — provider, event, preset, route, and default constants.
- `src/events.ts` — durable event types, vocabulary registration, redaction/bounds, append helpers, binding fold.
- `src/executable.ts` — CLI resolution, version parsing, safe Doctor.
- `src/spawn.ts` — Agent SDK `SpawnedProcess` wrapper over DSH subprocess.
- `src/async-queue.ts` — bounded closeable async input/output queues.
- `src/sdk-messages.ts` — SDK message normalization and protocol fixtures' owning parser.
- `src/supervisor.ts` — per-session long-lived query/process state machine.
- `src/permission.ts` — DSH approval bridge and policy mapping.
- `src/adapter.ts` — DSH LLM adapter and StreamChunk mapping.
- `src/preset-route.ts` — preset-scoped `agent/request` route override.
- `src/preset-installer.ts` — idempotent managed preset install/remove.
- `src/doctor-routes.ts` — package-private Web endpoints.
- `src/bin.ts` — `doctor`, `install-preset`, `remove-preset` CLI.

### Preset

- `preset/agent.cordis.yml` — minimal preset composition containing `dsh-claude-code/preset-route`.
- `preset/preset.yml` — display metadata.

### Client

- `src/client/index.tsx` — client entry and registrations.
- `src/client/conversation.ts` — activity turn-data projection and selector.
- `src/client/ClaudeActivity.tsx` — collapsible activity card.
- `src/client/ClaudeCodeSettings.tsx` — Doctor panel and configuration guidance.
- `src/client/locales.ts` — zh/en copy.
- `src/client/styles.ts` — DSH-token-based inline styles.

### Tests

- `test/executable.test.ts`
- `test/events.test.ts`
- `test/sdk-messages.test.ts`
- `test/spawn.test.ts`
- `test/supervisor.test.ts`
- `test/permission.test.ts`
- `test/adapter.test.ts`
- `test/preset-installer.test.ts`
- `test/client-conversation.test.tsx`

## Tasks

### Task 1 — Scaffold the distributable DSH bundle

1. Create package metadata, exports, scripts, TypeScript configs, tsdown config, Vitest config, license, ignore file, and repo instructions.
2. Pin `@anthropic-ai/claude-agent-sdk` to `0.3.233`; use installed DSH rc.5-compatible dev dependencies and wildcard/compatible peer dependencies.
3. Configure the DSH manifest with bundle patch and Web client entry.
4. Add an empty Host entry, client entry, preset route subpath, and CLI entry that compile.
5. Install dependencies with `/opt/homebrew/bin/pnpm` using `/opt/homebrew/bin` in PATH. Keep development optional native bindings because Vitest/tsdown require Rolldown's platform package; runtime still forces the resolved local Claude executable.
6. Verify `pnpm typecheck` and `pnpm build` produce the expected exports.

Expected evidence: install succeeds, package compiles, `lib/` contains Host/Client/CLI/preset-route bundles.

### Task 2 — Define durable events and safe normalization

1. Define `claude-code/session-bound` and `claude-code/activity` TypeScript augmentations.
2. Register both event names in `KNOWN_SESSION_EVENT_TYPES` at plugin activation.
3. Implement bounded string/object summaries with recursive secret-key redaction.
4. Implement append helpers that resolve the active Agent, turn, step, and ordinal once per bridge request.
5. Implement the binding fold used to resume a prior Claude session.
6. Add fixture-driven tests for lossless JSON, truncation, redaction, ordering, and binding fold.

Expected evidence: event tests pass and no raw credential-shaped value enters a persisted fixture.

### Task 3 — Implement executable resolution, Doctor, and managed process adapter

1. Resolve configured absolute path, PATH, and macOS fallbacks in the approved order.
2. Parse `claude --version` without shell interpretation.
3. Implement safe `claude auth status` probing only if a stable JSON/text contract is available; otherwise report `unknown` rather than scrape sensitive output.
4. Implement an EventEmitter-compatible SDK `SpawnedProcess` adapter over `ctx.subprocess.spawn` with piped stdin/stdout/stderr, explicit cwd/env, whole-tree termination, exit/error events, and bounded stderr diagnostics.
5. Preserve the subprocess service's credential-shaped ambient environment scrub. Forward no credential variables explicitly.
6. Add fake-handle tests for events, kill, exit code, error, stderr, and cleanup.

Expected evidence: resolver detects `/Users/normanzuo/.local/bin/claude`; process wrapper unit tests pass.

### Task 4 — Implement the long-lived Claude supervisor

1. Implement a closeable async input queue for SDK user messages.
2. Create one supervisor entry per DSH session with states `starting`, `idle`, `running`, `interrupting`, `disconnected`, `outcome-unknown`, and `disposed`.
3. Start SDK `query()` with the local executable, Claude Code system prompt preset, all local setting sources, partial messages, default permission mode, custom process spawn, and optional resume/model.
4. Pump SDK messages exactly once and route each message to the active DSH request.
5. Capture initialization/session id and persist the binding event.
6. Complete one request on its matching top-level result while keeping the streaming input source alive.
7. Support interrupt, termination fallback, idle eviction, max-process LRU eviction, resume, plugin disposal, and no-replay crash classification.
8. Add a transport factory seam so all state-machine tests use fake SDK queries without network/model calls.

Expected evidence: state-machine tests cover multi-turn reuse, resume, idle eviction, concurrency refusal, cancellation, crash-before-activity, crash-after-activity, and shutdown.

### Task 5 — Implement permission bridging

1. Implement `canUseTool` with access to the active Agent/request state.
2. Create a stable DSH call id from the Claude tool-use id only where the public branding helper permits; otherwise omit callId and put the bounded summary in `reason`.
3. Map DSH `allowed-once` to SDK allow with unchanged input.
4. Map rejected/cancelled/unavailable to SDK deny with stable messages.
5. Do not infer a DSH sandbox mode from prompt text; the public model-call contract has no sandbox-mode signal. Keep Claude in default permission mode and bridge every callback.
6. Append pending and decided activity events and mark permission work as side-effect-relevant activity for crash classification.
7. Test every approval outcome, fail-closed audit behavior, secret redaction, and missing active-turn ownership.

Expected evidence: permission tests pass and the callback never grants on unavailable/cancelled outcomes.

### Task 6 — Implement the DSH LLM bridge and preset route

1. Implement an `LlmAdapter` advertising `default`, `sonnet`, `opus`, and `haiku` aliases.
2. Extract only the newest direct human text from DSH messages; reject unsupported image-only requests.
3. Call the supervisor and map Claude partial text, usage, finish, abort, and errors into valid DSH `StreamChunk` order.
4. Ensure no Claude tool call becomes a DSH tool-call chunk.
5. Implement the preset-scoped `agent/request` waterfall override to select the Claude route.
6. Ensure auxiliary title/compaction calls and native presets are not intercepted.
7. Test exact StreamChunk ordering, no duplicate text, empty reply, cancellation, usage, failure normalization, and route scope.

Expected evidence: adapter tests and DSH invariant/type checks pass.

### Task 7 — Install the managed Agent Preset

1. Package the minimal preset composition and metadata.
2. Implement idempotent installation under `$DSH_HOME/.agent-presets/claude-code-cli` using atomic writes.
3. Mark generated files with an exact managed header and compare their complete packaged contents.
4. Create only absent files with a no-clobber atomic publish; accept exact current content and refuse every mismatch. Future upgrades must explicitly enumerate exact prior managed contents before replacing them.
5. Implement remove that deletes only exact managed files and then the empty directory.
6. Call ensure-install during Host activation and expose CLI install/remove commands.
7. Add tests using a temporary DSH home for install, rerun, upgrade, user edit refusal, and remove.

Expected evidence: the DSH preset roster discovers the installed preset without changing native preset roots.

### Task 8 — Implement client activity and Doctor UI

1. Add client event type augmentation if required by the client runtime.
2. Register a conversation definition that accumulates Claude activity per turn and publishes `claudeCode` turn data.
3. Register a turn-tail selector that mounts only when the closing turn has Claude activity.
4. Render ordered, collapsible activity rows with status, tool, bounded details, permission, error, subagent, and usage views.
5. Add localized zh/en copy and accessible controls.
6. Register a Settings section that calls same-origin Doctor endpoints and never renders secrets.
7. Add projection/selector tests and focused component tests where the existing toolchain supports them.

Expected evidence: Client typecheck/build passes; fixture snapshot demonstrates native turns render no card and Claude turns render ordered activity.

### Task 9 — Documentation and package verification

1. Write README architecture, install, use, permission boundary, configuration, troubleshooting, and uninstall sections.
2. Write idempotent `INSTALL.md` for coding agents.
3. Add package-content verification and ensure source maps do not include secrets or machine-specific paths.
4. Run `pnpm check` and inspect the packed tarball.
5. Initialize git and commit the verified package in coherent slices if the working tree is clean.

Expected evidence: clean check, inspectable tarball, installation instructions match actual commands.

### Task 10 — Linked-profile integration and live smoke

1. Link-install the project into the current Web profile using `dsh plugin --profile web add link:/Users/normanzuo/PersonalRepos/dsh-claude-code` or the packaged app equivalent.
2. Rebuild the affected client-plugin artifact through the package build; do not start a replacement DSH server.
3. Refresh the existing DSH Web GUI and confirm the preset appears.
4. Verify one existing native preset turn remains unchanged.
5. Run a minimal Claude read-only live turn after confirming the CLI is authenticated.
6. Verify a file-edit permission request reaches DSH approval and can be denied/allowed once.
7. Verify cancel, browser refresh, DSH restart resume, idle resume, and no orphan Claude process.
8. Record exact versions and evidence in `docs/aegis/evidence/`.

Expected evidence: all acceptance scenarios pass on macOS with Claude Code 2.1.233 and installed DSH rc.5.

## Verification commands

Run with `PATH=/opt/homebrew/bin:$PATH`:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination ./dist-pack
pnpm check
```

Profile verification uses the packaged DSH command available from the app environment; determine its exact executable before mutation. Never start a second Web server to validate the existing GUI.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| SDK/CLI message drift | pin aligned SDK, feature-detect, normalize unknown events as bounded warnings, fixture tests |
| streaming input closes after first result | live multi-turn smoke; if current SDK fails, use one query process per active turn with resume and document the design exception rather than silently duplicating turns |
| duplicated visible text from partial/final messages | per-request text accumulator and source precedence tests |
| permission callback loses DSH agent context | bind active request explicitly in supervisor; do not depend only on ambient async context |
| user preset drift | tiny managed preset, hash guard, refuse overwrite |
| native DSH sessions affected | route override lives only in the Claude preset; native regression smoke |
| leaked secrets in activity | recursive key redaction before persistence plus bounded fixtures |
| orphan Claude descendants | DSH managed subprocess tree ownership, terminate/join on cancel, eviction, unload, and smoke check |
| misleading sandbox claims | README and UI state exact permission boundary; no kernel confinement claim |

## Stop / rewind rules

- If a required DSH seam is not public in rc.5, stop that slice and redesign through an existing public seam; do not import private build chunks.
- If Agent SDK 0.3.233 cannot remain long-lived without duplicate turns or closed permission input, record the evidence and rewind to per-turn query+resume rather than patching SDK internals.
- If local Claude auth cannot be used from DSH's scrubbed environment without forwarding a secret, stop and ask the user to authenticate through a supported config/keychain path.
- If the client slot cannot interleave or tail-render plugin activity through public APIs, ship a grouped turn-tail card rather than modifying the DSH shell.
- If automatic preset installation would overwrite user content, refuse and give the exact CLI repair command.
