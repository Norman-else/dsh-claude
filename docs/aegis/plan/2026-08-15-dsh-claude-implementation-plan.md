# dsh-claude Implementation Plan

Status: implemented; persistence and background-task presentation amended
Date: 2026-08-15
Parent spec: `docs/aegis/spec/2026-08-15-dsh-claude-spec.md`

## Scope check

### Facts

- Target project is a standalone `dsh-claude` repository.
- Installed DSH is `0.1.0-rc.5` and exposes public LLM adapter, agent request waterfall, session event extension, subprocess, approval, Agent Preset, client conversation projection, slots, Web server, and client-module bundle surfaces.
- Local Claude Code is `2.1.233`, resolved through the documented executable lookup order.
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
- Background Claude tasks may settle after a top-level result. Claude Code retains execution ownership; the plugin observes SDK lifecycle, persists a bounded task board, and never claims per-task cancellation.

### Requirement Ready Check

- Product behavior: approved.
- Ownership/source-of-truth: approved.
- Permission behavior: approved.
- Platform scope: macOS-first.
- Compatibility boundary: pure out-of-tree plugin; no DSH core edits.
- Security amendment: approved; permission bridge, no kernel sandbox claim.

### Ripple Signal Triage

- New public package/bundle surface: yes.
- New durable session event types: superseded — current runtime writes a plugin-owned sidecar and no custom DSH events.
- New security/permission boundary: yes.
- New client projection and settings page: yes.
- Migration: readable historical custom events import idempotently into the sidecar; new logs never append them.
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
- The bundle registers its package-contained `preset/` directory as a read-only system preset root through the public `agent-presets.config.roots` contract.
- A normal `dsh plugin --profile <name> remove @norman-else/dsh-claude` removes both the plugin and preset; activation removes only exact legacy copies created by versions before 0.1.2 and preserves modified content.

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
- `src/events.ts` — redaction/bounds, sidecar payload types, and decode-only historical event folds.
- `src/sidecar.ts` — schema validation, serialized atomic persistence, resume binding, activity/context/tasks state, and legacy import.
- `src/http.ts`, `src/projection-routes.ts` — trusted non-cacheable browser projection without resume identity.
- `src/executable.ts` — CLI resolution, version parsing, safe Doctor.
- `src/spawn.ts` — Agent SDK `SpawnedProcess` wrapper over DSH subprocess.
- `src/async-queue.ts` — bounded closeable async input/output queues.
- `src/sdk-messages.ts` — SDK message normalization and protocol fixtures' owning parser.
- `src/supervisor.ts` — per-session long-lived query/process state machine.
- `src/permission.ts` — DSH approval dispatch and policy mapping.
- `src/user-question.ts` — Claude `AskUserQuestion` mapping to DSH's native user-question service.
- `src/adapter.ts` — DSH LLM adapter and StreamChunk mapping.
- `src/preset-route.ts` — preset-scoped `agent/request` route override.
- `src/preset-installer.ts` — legacy managed preset install/remove using templates retained under `legacy-preset/`.
- `src/doctor-routes.ts` — package-private Web endpoints.
- `src/bin.ts` — `doctor`, `install-preset`, `remove-preset` CLI.

### Preset

- `preset/claude/agent.cordis.yml` — minimal preset composition containing `dsh-claude/preset-route`; the `claude` directory is the discovered preset id.
- `preset/claude/preset.yml` — display metadata.

### Client

- `src/client/index.tsx` — client entry and registrations.
- `src/client/projection.ts` — session-scoped validated sidecar polling source.
- `src/client/conversation-sidecar.ts` — Claude turn marker, per-step in-flow chat-node Definition, and sidecar activity fold.
- `src/client/ClaudeActivityNode.tsx` — native-style keyed chat renderer for step-scoped activity.
- `src/client/ClaudeActivityTail.tsx` — task-launcher-only turn-tail contribution.
- `src/client/ClaudeCodeSettings.tsx` — Doctor panel and configuration guidance.
- `src/client/locales.ts` — zh/en copy.
- `src/client/styles.ts` — DSH-token-based inline styles.

### Tests

- `test/executable.test.ts`
- `test/events.test.ts`
- `test/sdk-messages.test.ts`
- `test/spawn.test.ts`
- `test/supervisor.test.ts`
- `test/permission.test.ts`, `test/user-question.test.ts`
- `test/adapter.test.ts`
- `test/preset-installer.test.ts`
- `test/sidecar.test.ts`, `test/projection-routes.test.ts`
- `test/client-projection.test.ts`, `test/client-sidecar-conversation.test.ts`

## Tasks

### Task 1 — Scaffold the distributable DSH bundle

1. Create package metadata, exports, scripts, TypeScript configs, tsdown config, Vitest config, license, ignore file, and repo instructions.
2. Pin `@anthropic-ai/claude-agent-sdk` to `0.3.233`; use installed DSH rc.5-compatible dev dependencies and wildcard/compatible peer dependencies.
3. Configure the DSH manifest with bundle patch and Web client entry.
4. Add an empty Host entry, client entry, preset route subpath, and CLI entry that compile.
5. Install dependencies with `/opt/homebrew/bin/pnpm` using `/opt/homebrew/bin` in PATH. Keep development optional native bindings because Vitest/tsdown require Rolldown's platform package; runtime still forces the resolved local Claude executable.
6. Verify `pnpm typecheck` and `pnpm build` produce the expected exports.

Expected evidence: install succeeds, package compiles, `lib/` contains Host/Client/CLI/preset-route bundles.

### Task 2 — Define sidecar persistence and safe normalization

This task supersedes the original custom-event design. Runtime vocabulary registration cannot protect Desktop cold-load because persisted logs are validated before plugin activation.

1. Define a schema-versioned sidecar for binding, ordered activities, context usage, and tasks.
2. Implement bounded normalization and recursive secret redaction before every durable write.
3. Serialize writes per session and publish atomically with restrictive filesystem modes.
4. Preserve decode-only historical event folds for idempotent legacy import.
5. Expose only presentation fields through a trusted Host endpoint; exclude the resume binding.
6. Add repository, route, Client polling, cleanup, redaction, and legacy-import regressions.

Expected evidence: new session logs contain no `claude-code/*` events, old readable events import safely, and Desktop cold-load succeeds.

### Task 3 — Implement executable resolution, Doctor, and managed process adapter

1. Resolve configured absolute path, PATH, and macOS fallbacks in the approved order.
2. Parse `claude --version` without shell interpretation.
3. Implement safe `claude auth status` probing only if a stable JSON/text contract is available; otherwise report `unknown` rather than scrape sensitive output.
4. Implement an EventEmitter-compatible SDK `SpawnedProcess` adapter over `ctx.subprocess.spawn` with piped stdin/stdout/stderr, explicit cwd/env, whole-tree termination, exit/error events, and bounded stderr diagnostics.
5. Preserve the subprocess service's credential-shaped ambient environment scrub. Forward no credential variables explicitly.
6. Add fake-handle tests for events, kill, exit code, error, stderr, and cleanup.

Expected evidence: resolver detects an authenticated local Claude executable; process wrapper unit tests pass.

### Task 4 — Implement the long-lived Claude supervisor

1. Implement a closeable async input queue for SDK user messages.
2. Create one supervisor entry per DSH session with states `starting`, `idle`, `running`, `interrupting`, `disconnected`, `outcome-unknown`, and `disposed`.
3. Start SDK `query()` with the local executable, Claude Code system prompt preset, all local setting sources, partial messages, default permission mode, custom process spawn, and optional resume/model.
4. Pump SDK messages exactly once and route each message to the active DSH request.
5. Capture initialization/session id and persist the sidecar binding.
6. Complete one request on its matching top-level result while keeping the streaming input source alive.
7. Support interrupt, termination fallback, idle eviction, max-process LRU eviction, resume, plugin disposal, and no-replay crash classification.
8. Add a transport factory seam so all state-machine tests use fake SDK queries without network/model calls.

Expected evidence: state-machine tests cover multi-turn reuse, resume, idle eviction, concurrency refusal, cancellation, crash-before-activity, crash-after-activity, and shutdown.

### Task 5 — Implement permission bridging

1. Implement `canUseTool` with access to the active Agent/request state.
2. Create a stable DSH call id from the Claude tool-use id only where the public branding helper permits; otherwise omit callId and put the bounded summary in `reason`.
3. Map DSH `allowed-once` to SDK allow with unchanged input.
4. Map rejected/cancelled/unavailable to SDK deny with stable messages, except when the newest durable sandbox mode shows that the user selected Full access while the request was open.
5. Fold the current DSH sandbox mode before and after every permission callback so live access-selector changes update the long-lived Query and stale approval closure cannot override explicit Full access.
6. Persist pending and decided sidecar activities, settle denied native tool mirrors with an error result, and mark permission work as side-effect-relevant activity for crash classification.
7. Test every approval outcome, live Full access transition, denied tool-card settlement, fail-closed audit behavior, secret redaction, and missing active-turn ownership.

Expected evidence: permission tests pass and the callback never grants on unavailable/cancelled outcomes.

### Task 5A — Bridge Claude user questions to the native DSH composer

1. Inject the public `ctx.userQuestions` service and route `AskUserQuestion` before approval or Full access handling.
2. Validate and map Claude question prompts, headers, choices, and multi-select flags to stable DSH question ids.
3. Convert selected labels and custom text back to Claude's `updatedInput.answers` object while preserving the original questions.
4. Fail closed on malformed input, unavailable UI, cancellation, abort, or missing active-turn ownership; never open an approval row for a question.
5. Persist only bounded question lifecycle metadata, never the user's answer content.
6. Test single-select, multi-select, custom text, Full access non-bypass, malformed input, and failure behavior.

Expected evidence: Claude blocks on DSH's native question composer and resumes with the exact selected answer mapping.

### Task 6 — Implement the DSH LLM bridge and preset route

1. Implement an `LlmAdapter` advertising `default`, `sonnet`, `opus`, and `haiku` aliases.
2. Resolve the newest direct human DSH message through the public attachment service. Keep text-only prompts as strings; convert ordered text/image blocks into Agent SDK `MessageParam` content.
3. Enforce the Host deployment's media, count, per-image byte, aggregate byte, pixel, and compatible dimension limits before and after verified reads; honor cancellation and keep errors bounded and attachment-free.
4. Call the supervisor and map Claude partial text, usage, finish, abort, and errors into valid DSH `StreamChunk` order.
5. Ensure no Claude tool call becomes a DSH tool-call chunk and no image bytes enter sidecars or activity records.
6. Implement the preset-scoped `agent/request` waterfall override to select the Claude route.
7. Ensure auxiliary title/compaction calls and native presets are not intercepted.
8. Test exact StreamChunk ordering, text-only compatibility, pure/mixed/multiple images, limits, verified-read failures, cancellation, no duplicate text, empty reply, usage, failure normalization, and route scope.

Expected evidence: adapter tests and DSH invariant/type checks pass.

### Task 7 — Ship the Agent Preset with the bundle

1. Package the minimal preset composition and metadata under `preset/claude/`, because the roster scans each child directory of a configured root as one preset id.
2. Register that directory as a read-only system root through the bundle patch and the public `agent-presets.config.roots` contract.
3. Resolve the package directory from the host profile so published and linked installs use the same patch.
4. Keep the legacy installer/remover only for migration and CLI compatibility; Host activation removes an exact pre-0.1.2 managed copy and preserves any user-modified content.
5. Validate every legacy file before removing any file so migration cannot leave a partially deleted preset.
6. Add tests for legacy install, upgrade, atomic user-edit refusal, and remove.

Expected evidence: the DSH preset roster discovers the package-contained preset, and normal profile dependency removal leaves no plugin-owned preset outside the package.

### Task 8 — Implement Client sidecar projection, activity, and Doctor UI

1. Register a session-scoped projection hook backed by the trusted Host endpoint.
2. Load immediately on first subscription, poll only while mounted, validate responses, and abort on cleanup.
3. Derive Claude turn ownership with one `turn/start` Context and Claude assistant-message updates; replay a multi-step turn in regression coverage so duplicate Context starts cannot recur.
4. Materialize one step-scoped keyed chat node immediately before each Claude assistant message and render matching sidecar activity with native DSH disclosure, icon, status, typography, and spacing primitives. Keep the turn tail task-launcher-only.
5. Add localized zh/en copy and accessible controls.
6. Register a Settings section that calls same-origin Doctor endpoints and never renders secrets.
7. Provide one extensible Claude Code global-settings registry and trusted same-origin API whose descriptors explicitly validate fields, enumerate bounded public options, and declare whether changes require a new session or restart.
8. Register `outputStyle` first: merge only that key into `~/.claude/settings.json`, remove it for Default, discover only bounded names from user output-style frontmatter, serialize updates, atomically replace with user-only permissions, and never expose unrelated settings or prompt bodies.
9. For registry installs, update by adding the validated exact latest package version and verify both profile and installed manifests before reporting success; never replace linked or ambiguous installs.
10. Add route, global-settings, update execution, polling, projection/selector, and focused component tests.

Expected evidence: Client typecheck/build passes; real assembler regression demonstrates activity 1, assistant 1, activity 2, assistant 2 ordering, while native turns render no Claude activity node.

### Task 8A — Redesign Claude background task presentation

1. Retain a bounded optional origin turn on task snapshots and a redacted task id on lifecycle activities without breaking schema-version-1 sidecars.
2. Group the DSH details panel into Running and Finished cards with duration, token, tool-use, type, last-tool, and summary metadata.
3. Implement Finished collapse and mounted-Client-only Clear; do not mutate canonical sidecar truth.
4. Expose only already-redacted matching sidecar activity as “View activity”; never read Claude transcript paths or resume identity.
5. Add a matching-turn launcher for running, completed, and failed tasks; remove the permanent session-header utility and do not create a detached entry for tasks without a known origin.
6. Scope the details panel to the selected origin turn so historical launchers do not open the latest session-wide task list.
7. Do not expose per-task Stop because the public SDK and DSH contracts only support whole-turn cancellation.
8. Add normalization, sidecar, supervisor, and pure Client-selection regressions.

Expected evidence: grouped interaction tests pass, the panel and turn-tail share one details controller, and no unsupported task mutation surface exists.

### Task 9 — Documentation and package verification

1. Write README architecture, install, use, permission boundary, configuration, troubleshooting, and uninstall sections.
2. Write idempotent `INSTALL.md` for coding agents.
3. Add package-content verification and ensure source maps do not include secrets or machine-specific paths.
4. Run `pnpm check` and inspect the packed tarball.
5. Initialize git and commit the verified package in coherent slices if the working tree is clean.

Expected evidence: clean check, inspectable tarball, installation instructions match actual commands.

### Task 10 — Linked-profile integration and live smoke

1. Link-install the project into the current Web profile using `dsh plugin --profile web add link:/path/to/dsh-claude` or the packaged app equivalent.
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
| image bytes or attachment identity leak | resolve only through `ctx.attachments`, use bounded index-only errors, and keep SDK input out of sidecar/activity persistence |
| attachment policy drift across DSH versions | consume runtime `imageLimits`; require the rc.6 public baseline and feature-detect the rc.8 dimension field |
| orphan Claude descendants | DSH managed subprocess tree ownership, terminate/join on cancel, eviction, unload, and smoke check |
| misleading sandbox claims | README and UI state exact permission boundary; no kernel confinement claim |

## Stop / rewind rules

- If a required DSH seam is not public in rc.5, stop that slice and redesign through an existing public seam; do not import private build chunks.
- If Agent SDK 0.3.233 cannot remain long-lived without duplicate turns or closed permission input, record the evidence and rewind to per-turn query+resume rather than patching SDK internals.
- If local Claude auth cannot be used from DSH's scrubbed environment without forwarding a secret, stop and ask the user to authenticate through a supported config/keychain path.
- If the client slot cannot interleave or tail-render plugin activity through public APIs, ship a grouped turn-tail card rather than modifying the DSH shell.
- If automatic preset installation would overwrite user content, refuse and give the exact CLI repair command.
