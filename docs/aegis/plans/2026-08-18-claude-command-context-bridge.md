# Claude Command and Context Bridge Implementation Plan

**Goal:** Discover and execute Claude Code Skills/Commands through DSH’s native slash-command surface and show authoritative Claude context-window usage beside model selection.

**Architecture:** Claude Agent SDK Query remains the metadata and execution source of truth. DSH’s public per-agent command registry owns discovery/presentation and queues slash invocations back through `Agent.followup()` so the ordinary DSH turn remains the sole execution owner. The SDK `getContextUsage()` result is normalized into the plugin-owned sidecar; a session-scoped Client projection supplies the latest sample to an additive `conversation.input.right` meter.

**Amendment:** The custom-event persistence and event-view steps below are historical and superseded by `src/sidecar.ts`, `src/projection-routes.ts`, and `src/client/projection.ts`. Current runtime appends no `claude-code/*` session events.

**Tech Stack:** TypeScript, Cordis, DSH public agent/commands/session/client slot contracts, Claude Agent SDK 0.3.233, React 18, Vitest, tsdown.

**Baseline / Authority Refs:**
- `docs/aegis/spec/2026-08-15-dsh-claude-code-spec.md` §§2.5, 3.2, 3.5–3.6, 5.3, 7–8
- `docs/aegis/plan/2026-08-15-dsh-claude-code-implementation-plan.md`
- `AGENTS.md`

**Compatibility Boundary:** Out-of-tree plugin only; no installed DSH edits, private imports, copied agent-loop logic, duplicate turn driver, or credential/path persistence. Existing DSH commands retain ownership on collisions. Existing ordinary Claude prompts, approval bridging, activity projection, cancellation, resume, and process limits must continue to work.

**TDD Route:**
- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Test posture: focused post-change contract regressions plus live GUI integration
- Reason: no strict TDD request; public integration seams need proportional fixtures and runtime evidence.
- Verification: focused Vitest suites, `PATH=/opt/homebrew/bin:$PATH pnpm check`, existing DSH URL browser smoke.

## Scope Check

### Facts
- `Query.supportedCommands()` and `Query.getContextUsage()` are public SDK methods.
- DSH `CommandRuntime.register()` supports per-agent scoped commands through `agent.ctx` and publishes discovery changes.
- `Agent.followup()` is the public ordinary-turn delivery path.
- `conversation.input.right` is an additive session-scoped slot positioned between model selection and send.
- `sessions.provide()` can supply a plugin-owned per-session projection hook to additive slots.

### Assumptions to verify
- Calling SDK metadata methods on an initialized streaming Query does not consume user-turn output.
- A slash line delivered as an ordinary DSH follow-up is handled by Claude Code’s streaming-input protocol.
- Agent creation volume is bounded enough for metadata initialization under the existing process cap; failures must degrade without blocking prompts.

### Unknowns with fail-loud handling
- Claude catalogs may contain names outside DSH’s command regex; exclude those entries with bounded diagnostics.
- A second collision on `claude-<name>` skips that entry rather than shadowing another owner.
- CLI local-only commands may produce no assistant text; the DSH turn must still settle normally.

### Requirement Ready Check
- Requirement source refs: direct user request and approved design choice in this session.
- Goals and scope refs: command discovery/execution plus screenshot-matched context meter.
- Acceptance refs: spec §8.
- Open blocker questions: none.
- Decision: ready.

### Ripple Signal Triage
- New durable event type: superseded — context usage is stored in the plugin sidecar.
- New per-agent command registrations: yes.
- New client projection and input control: yes.
- New security boundary: no; safe aggregate token metadata only.
- Migration: none; old histories simply have no context sample.

### Change Necessity
- User-visible need: native `/` discovery/execution and context-window visibility.
- No-change option: SDK capabilities exist but are not wired to DSH surfaces.
- Why code is necessary: neither DSH’s command registry nor input slots can infer Claude metadata.
- Minimum boundary: supervisor metadata methods, command bridge, safe event, client projection/meter.
- Decision: code-change.

### Existence Check
- Proposed surfaces: command bridge module, context view/meter.
- Reuse candidates: DSH CommandRuntime, Agent.followup, conversation views, input-right slot.
- Creation proof: glue is required between two public owners; no new turn owner or transport is created.
- Entropy impact: registrations are agent-scoped and retire with the agent; latest durable event supersedes earlier samples in projection.
- Decision: add-with-proof.

### Architecture Integrity Lens
- Invariant: DSH alone opens/records/drives turns; Claude Query alone owns its internal loop and context accounting.
- Canonical owners: SDK for catalog/usage, DSH for command UI and turn lifecycle.
- Overlap: direct Query driving inside a command handler is forbidden.
- Higher-level simplification: `Agent.followup()` avoids a parallel command execution stream.
- Verdict: proceed.

### Complexity Budget
- Artifact class: integration owner split across host supervisor/bridge and client projection/control.
- Current pressure: `src/supervisor.ts` is already large; do not add catalog reconciliation/UI logic there.
- Better boundary: extract `src/command-bridge.ts`, `src/context-usage.ts`, `src/client/context-usage.ts`, and `src/client/ClaudeContextMeter.tsx`.
- Budget result: within-budget with extraction.

## File Map

- Modify `package.json`, `pnpm-lock.yaml`: add public DSH commands peer/dev dependency and client injection only if required.
- Historical (superseded): `src/event-vocabulary.ts` registration and context event append/fold helpers.
- Current: `src/events.ts` normalization/types plus `src/sidecar.ts` persistence and legacy decoding.
- Modify `src/supervisor.ts`: shared entry acquisition plus serialized `supportedCommands()` / `getContextUsage()` metadata reads and contained post-turn refresh.
- Create `src/command-bridge.ts`: per-agent catalog reconciliation, collision policy, aliases, follow-up delivery, lifecycle cleanup.
- Modify `src/index.ts`: optional/public command injection, agent lifecycle wiring, context sample append.
- Historical (superseded): `src/client/context-usage.ts` event Definition; current projection lives in `src/client/projection.ts`.
- Create `src/client/ClaudeContextMeter.tsx`: circular trigger and aggregate popover.
- Modify `src/client/index.tsx`, `src/client/styles.ts`, `src/client/locales.ts`: register projection/slot and UI copy/styles.
- Modify `test/events.test.ts`, `test/supervisor.test.ts`, `test/client-conversation.test.tsx`; create `test/command-bridge.test.ts`, `test/client-context-meter.test.tsx` as needed.
- Modify spec/checkpoint evidence docs.

## Tasks

### Task 1 — Safe context event contract

**Why:** Persist the last authoritative aggregate so refresh/history replay retains the meter.

**Impact/Compatibility:** Additive ignorable plugin vocabulary; no raw paths, prompt content, MCP tool names, or credentials.

**Steps:**
1. Add `CLAUDE_CONTEXT_USAGE_EVENT` and register it on the running Host singleton.
2. Define the event payload and normalization that clamps non-negative integer counts, percentage 0–100, category count, names, and colors.
3. Add append/latest fold helpers.
4. Extend event vocabulary/normalization tests, including rejection or sanitization of excluded fields.
5. Run `PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run test/events.test.ts`.

### Task 2 — Supervisor metadata seam

**Why:** Reuse the one owned Query for commands and context metadata without adding a process or turn owner.

**Impact/Compatibility:** Metadata requests share admission/process-cap/resume behavior; ordinary `runTurn` semantics remain unchanged.

**Steps:**
1. Extract an admitted entry-acquisition helper used by both turns and metadata reads.
2. Add `supportedCommands(agent, model)` and `contextUsage(agent, model)` methods using public Query APIs.
3. Contain context refresh failure after successful turn completion so it cannot fail model output.
4. Extend `FakeQuery` with SDK metadata methods and add serialization/process-cap/refresh tests.
5. Run `PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run test/supervisor.test.ts`.

### Task 3 — Per-agent Claude command bridge

**Why:** Make the SDK catalog visible and executable in DSH’s native `/` menu.

**Impact/Compatibility:** Existing effective DSH names win. Scoped registrations unwind with agent disposal. Handlers queue normal turns; they never call Query execution directly.

**Steps:**
1. Add the public commands package to peer/dev dependencies.
2. Implement name validation, collision prefixing, alias reconciliation, and stale-registration disposal.
3. Build handlers with `createUserMessage({ source: { kind: 'user' } })` and `agent.followup()` using the exact Claude slash line.
4. Wire initial reconciliation for Claude-preset agents and refresh after successful turns/metadata refresh.
5. Test native names, DSH collisions, aliases, invalid names, exact raw input, disposal, and catalog replacement.
6. Run `PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run test/command-bridge.test.ts test/supervisor.test.ts`.

### Task 4 — Latest context projection and meter UI

**Why:** Match the requested model-adjacent context display without replacing DSH composer ownership.

**Impact/Compatibility:** Additive `conversation.input.right` entry; no private component/CSS imports.

**Steps:**
1. Define a `claudeContextUsage` conversation target whose builder retains the highest-seq context sample.
2. Register the node/view definitions and augment `ConversationViewSnapshotMap`.
3. Render a 28px circular percentage trigger and click/focus-controlled popover with used/max values, segmented bar, and category rows.
4. Use DSH theme tokens, keyboard dismissal, outside-click dismissal, accessible labels, and bounded layout.
5. Register the slot against the session-scoped sidecar projection; render nothing when no sample is available.
6. Add projection and SSR component tests for percentage, formatted token values, category ordering, and absence state.
7. Run `PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run test/client-projection.test.ts test/client-context-meter.test.tsx`.

### Task 5 — Integrated verification and evidence

**Why:** Prove both public seams work together in the installed GUI and preserve prior behavior.

**Steps:**
1. Run `PATH=/opt/homebrew/bin:$PATH pnpm check`; require Host/client typechecks, all tests, and build success.
2. Refresh `http://127.0.0.1:61300` after the client bundle rebuild.
3. Open a Claude-preset session, type `/`, verify Claude catalog entries and collision-prefixed entries.
4. Execute one harmless Claude Skill/custom command and verify it opens a normal DSH turn, renders activity, settles idle, and leaves no console error.
5. Verify the model-adjacent meter appears, opens, matches SDK total/max/percentage/categories, updates after a new turn, and survives refresh.
6. Re-run one ordinary prompt and one denied tool action to guard adapter/approval behavior.
7. Record bounded evidence in `docs/aegis/work/2026-08-15-dsh-claude-code/20-checkpoint.md` and commit only task-owned files.

## Risks and Mitigations

- **Metadata startup consumes process slots:** use the existing cap/idle eviction and degrade catalog/meter independently of prompting.
- **Command collision or churn:** snapshot effective DSH names before registering; reconcile with explicit disposers.
- **Duplicate execution owner:** handlers may only call `Agent.followup()`, never push Query input.
- **Sensitive SDK metadata:** whitelist aggregate fields; never serialize the full context response.
- Stale UI: sidecar revision polling plus post-turn refresh; missing projections show no meter rather than fabricated values.

## Retirement / Rollback

- No old command or context owner exists.
- Removing the bridge means disposing scoped registrations and unregistering the additive client slot/view; ordinary Claude turns remain intact.
- If DSH later exposes a first-class external command-catalog/usage provider, replace this glue rather than layering another catalog owner.

## Execution Readiness View

- Intent Lock: native Claude command discovery/execution plus screenshot-matched context meter.
- Scope Fence: public DSH/SDK seams only; no core patches or private UI reuse.
- Baseline Lock: approved spec and repository instructions above.
- Owner Constraints: SDK metadata; DSH commands/turns/presentation.
- Compatibility: DSH commands win collisions; ordinary prompt/approval/resume unchanged.
- Task Batches: event+metadata, command bridge, client meter, integration.
- Test Obligations: focused contracts, full `pnpm check`, live GUI and console evidence.
- Drift Rule: stop and return to design if slash execution cannot traverse `Agent.followup()` as an ordinary turn or if input-right cannot render additively.
- Evidence Required: catalog visible, skill executes, meter accurate/updates/persists, no console errors, full checks pass.

## Execution Route

- Decision: inline
- Evidence: host metadata, command lifecycle, durable event, and client projection share contracts and fixtures; parallel edits would collide in supervisor/events/index.
- Fallback: delegate isolated review only after implementation.
- User confirmation required: no — the design and collision policy were explicitly approved.
