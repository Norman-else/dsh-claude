# dsh-claude Product and Architecture Spec

Status: implemented baseline with sidecar persistence amendment
Date: 2026-08-15

## 1. Product / Requirement Baseline

### 1.1 Problem

DeepSeek Harness (DSH) can run its native agent loop and can expose external coding agents as delegated subagents, but it does not provide a first-class main-conversation experience backed by the user's already-installed local Claude Code CLI. The user wants to stay in the existing DSH Web profile, choose Claude Code for a new conversation, and retain Claude Code's own agent loop, tools, CLAUDE.md discovery, Skills, Hooks, Plugins, MCP configuration, authentication, and session behavior.

### 1.2 Goal

Ship an out-of-tree DSH bundle named `dsh-claude` that adds a `Claude Code CLI` Agent Preset to the current Web profile. A session using that preset routes each outer DSH model step into a complete Claude Code turn driven by the user's local CLI. DSH remains the conversation UI, durable presentation mirror, permission UI, process owner, and cancellation surface.

### 1.3 Required experience

1. Install the bundle into the existing `web` profile.
2. Create a blank DSH conversation and select the `Claude Code CLI` preset.
3. Send ordinary messages through the DSH composer.
4. Claude Code owns its internal agent loop and built-in tools.
5. DSH streams final user-visible text and renders complete Claude activity cards for thinking summaries, tool calls/results, subagents, permissions, usage, status, and failures.
6. Tool permission requests appear in the existing DSH approval flow.
7. A live Claude process remains attached to an active DSH session and is reclaimed after an idle limit.
8. DSH refresh/restart can resume the Claude session through its persisted Claude session id.
9. Existing non-Claude DSH presets and sessions keep their current behavior.

### 1.4 Non-negotiables

- Use the local Claude Code executable; do not call the Anthropic Messages API directly.
- Reuse the user's existing Claude authentication and `~/.claude` configuration.
- Do not store or return Claude credentials.
- Do not expose DSH tools to Claude as a second agent loop.
- Do not represent Claude-owned tool calls as DSH-owned tool execution.
- Do not automatically replay a prompt whose side-effect outcome is unknown.
- The first supported and verified platform is macOS.

### 1.5 Non-goals for v0.1

- Managing Claude login or credentials inside DSH.
- Switching a non-empty conversation between native DSH and Claude Code presets.
- Windows or Linux verification.
- Plugin-owned background-agent execution or continuation after the top-level Claude result. Claude Code may continue Claude-owned tasks; the plugin only observes and presents their SDK lifecycle.
- Publishing to npm before local installation and compatibility validation pass.
- Modifying DeepSeek Harness core APIs.

## 2. Architecture / Runtime Boundary Baseline

### 2.1 Integration shape

The plugin does not replace the process-global DSH `AgentFactory`. The Web profile keeps the native `dsh-agent-loop`. A plugin-provided Agent Preset contributes an `agent/request` waterfall listener that replaces the request route with the plugin's `claude` provider. The provider's adapter turns one DSH model request into one complete Claude Code agent turn and emits only final assistant content back through the DSH LLM stream.

This is an agent bridge at the LLM seam, not a claim that Claude Code is a stateless LLM provider.

### 2.2 Canonical owners

| Surface | Canonical owner |
| --- | --- |
| DSH conversation identity, turn boundaries, standard assistant text | DSH session and native agent loop |
| Claude context, internal agent loop, tool selection/execution | Claude Code CLI |
| Local Claude auth, settings, CLAUDE.md, Skills, Hooks, Plugins, MCP | Existing Claude Code installation and `~/.claude` |
| Claude process lifetime and whole-turn cancellation | Plugin process supervisor over DSH managed subprocess |
| Claude background task execution and per-task lifecycle | Claude Code CLI; plugin observes SDK lifecycle only |
| Tool permission decision UI and audit | DSH approval service |
| Claude-to-DSH session binding | Plugin-owned sidecar keyed by DSH session id |
| Claude internal activity presentation | Redacted sidecar data exposed through a trusted Host projection |

### 2.3 Agent SDK amendment

Use `@anthropic-ai/claude-agent-sdk` only as the supported typed protocol/process adapter for the local CLI. Configure `pathToClaudeCodeExecutable` with the resolved absolute user executable and set `spawnClaudeCodeProcess` to a wrapper backed by `ctx.subprocess`. The SDK must not choose its optional bundled binary and must not authenticate independently.

Required SDK options include:

- `pathToClaudeCodeExecutable`: resolved local CLI path
- `systemPrompt: { type: 'preset', preset: 'claude_code' }`
- `settingSources: ['user', 'project', 'local']`
- `includePartialMessages: true`
- `permissionMode`: mapped from the session's durable DSH sandbox mode (`read-only` → `plan`, `workspace-write` → `acceptEdits`, `danger-full-access` → `bypassPermissions`)
- `allowDangerouslySkipPermissions: true`: enables the explicitly confirmed DSH Full access mapping without activating it in other modes
- `canUseTool`: DSH approval bridge for modes where Claude still requests approval
- `cwd`: immutable DSH session cwd
- `resume`: persisted Claude session id when present
- explicit model only when the selected alias is not `default`
- `spawnClaudeCodeProcess`: DSH-managed process adapter

The version initially pinned for development is `@anthropic-ai/claude-agent-sdk@0.3.233`, aligned with the detected local Claude Code `2.1.233`. Runtime compatibility is feature-detected and diagnosed rather than inferred only from a version string.

### 2.4 Sandbox boundary amendment

The plugin reuses the DSH permission UI and maps its three durable sandbox modes into Claude permission behavior, but v0.1 does not claim kernel-level workspace confinement.

Reason: DSH's current process sandbox permits writes only to the workspace and temporary roots, while full Claude Code semantics and durable resume require writes under `~/.claude`. The public sandbox contract has no additional technical-state-root vocabulary. Silently bypassing `~/.claude`, copying credentials, or widening the workspace root would each violate a more important boundary.

The process still runs through `ctx.subprocess` for explicit argv, credential-shaped ambient environment scrubbing, cancellation, and whole-process-tree cleanup. A future DSH core extension may add explicit runtime state roots; that is outside this plugin.

### 2.5 Same-profile routing

The bundle adds:

- one host adapter route: `claude`
- one preset-scoped route plugin that overrides `agent/request` to `{ provider: 'claude', model: <alias> }`
- one user-visible preset: `claude`, shipped inside the package and registered as a read-only system preset root so dependency removal removes the complete integration

The preset contains no DSH model-facing filesystem, shell, skill, web, goal, todo, workflow, or subagent tools. Claude Code owns those capabilities. It may include only the route plugin and a minimal persona/presentation contribution needed by DSH.

## 3. Host Components

### 3.1 Executable resolver and Doctor

Resolution order:

1. configured absolute `executablePath`
2. `ctx.subprocess.resolveExecutable('claude')`
3. macOS fallback `$HOME/.local/bin/claude`
4. macOS fallback `/opt/homebrew/bin/claude`
5. macOS fallback `/usr/local/bin/claude`

Doctor reports only:

- resolved path
- CLI version
- SDK/CLI compatibility feature checks
- authentication status category when the CLI exposes it safely
- process handshake status
- current configured idle/concurrency limits

Doctor never returns token values, environment secrets, keychain data, or complete settings files.

### 3.2 Process supervisor

The supervisor is keyed by DSH session id and owns at most one live query/process per session.

Responsibilities:

- lazy start on the first bridged turn or metadata request (command discovery/context usage)
- maintain a streaming-input Claude query while the DSH session is active
- expose serialized, non-turn metadata reads for the current command catalog and context usage
- serialize one active DSH request per session
- record the Claude session id from initialization/result messages
- route SDK messages to the active request
- interrupt and terminate the owned process tree on DSH cancellation
- idle eviction (default 30 minutes)
- bounded live process count (default 4), evicting least-recently-idle entries before refusing
- dispose all processes during plugin shutdown
- restart with `resume` after normal eviction or host restart
- never automatically replay an in-flight prompt after an ambiguous crash

A crash before the request is accepted may fail normally. A crash after any Claude activity or permission/tool evidence marks the run `outcome-unknown` and requires a new human prompt.

### 3.3 Prompt mapping

For ordinary conversation calls, extract the newest direct DSH user message that entered the current step. Do not resend the whole DSH history because Claude's session is the context source of truth. Text-only input retains the existing string prompt path. Messages containing images become ordered Anthropic content blocks so pure-image, mixed text/image, and multiple-image input preserve the DSH block order.

DSH image blocks contain immutable attachment references, not paths or URLs. Resolve them only through the injected public `ctx.attachments.readImage(ref, signal)` service, which verifies stored bytes against the durable reference. Apply the deployment's authoritative `imageLimits` before and after reads: supported raster media types, per-image bytes, images per message, aggregate bytes, pixels, and dimensions where exposed by the compatible Host. Cancellation must settle promptly during resolution. Missing, unreadable, corrupt, unsupported, or over-limit images fail with bounded actionable errors that contain no attachment identity, path, raw bytes, base64, or underlying sensitive diagnostics.

DSH system prompts and tool schemas are not forwarded. Claude Code receives its own `claude_code` system prompt preset and local configuration. Image bytes exist only in the transient SDK input message; they are never written to sidecars, activity records, or logs.

Auxiliary DSH calls (`purpose: 'compaction' | 'session-title'`) are not routed through the Claude preset bridge unless they are explicitly agent-scoped ordinary conversation calls.

### 3.4 Output mapping

Map Claude partial output to DSH `StreamChunk`:

- first visible text -> `block-start` for text index 0
- visible text delta -> `text-delta`
- completion -> `block-end` with assembled text
- Claude result usage -> DSH `usage`
- successful result -> `finish: stop`
- cancellation -> `finish: aborted`
- normalized failure -> throw/finish through DSH LLM error normalization

Claude internal tool calls are not emitted as DSH `tool-call` chunks.

### 3.5 Plugin-owned sidecar

DSH session logs contain only DSH-supported event types. The plugin must not mutate `KNOWN_SESSION_EVENT_TYPES` or append `claude-code/*` events: Desktop validates persisted vocabulary before plugin activation, so runtime registration cannot make custom events cold-load compatible.

The canonical plugin state is a schema-versioned JSON sidecar keyed by the DSH session id under `$DSH_HOME/plugins/dsh-claude/sessions`. It stores the Claude resume binding, ordered activity records, latest aggregate context usage, and latest task snapshot. Writes are serialized per session and published with same-directory atomic rename; the directory is mode `0700` and documents are mode `0600`. Revisions increase monotonically, activities are capped, and every read is strictly validated.

Each DSH turn maps to exactly one Claude turn. Sidecar activities retain `turn`, `step`, and `ordinal` so the Client can place them immediately before the corresponding standard Claude assistant message in the chat flow. SDK `total_cost_usd` is cumulative across streaming-input turns and is retained as the latest cumulative value rather than summed.

The SDK `getContextUsage()` response remains authoritative. Persist only aggregate category counts and model/window figures; memory-file paths, MCP tool names, system-prompt section text, configuration content, and grid rendering data are excluded. All sidecar payloads are bounded and secret-aware: environment maps, credential-shaped keys, and known token fields are redacted before persistence.

For migration only, readable historical `claude-code/session-bound`, `claude-code/activity`, `claude-code/context-usage`, and `claude-code/tasks` events are imported idempotently into an absent or incomplete sidecar. They are decode-only legacy formats and are never appended by current runtime code.

### 3.6 Claude command bridge

For agents composed with the Claude preset, initialize the owned Query on the first metadata or turn request and read its authoritative `supportedCommands()` catalog. Reconcile per-agent DSH command registrations whenever the catalog is first loaded or refreshed.

- A non-conflicting Claude command keeps its native name and argument hint.
- Existing effective DSH commands remain authoritative. A colliding Claude command is exposed as `claude-<name>`; a further collision fails that entry loud rather than replacing another owner.
- Claude aliases follow the same rules and never replace DSH commands.
- A registered handler does not drive the Query directly. It creates a user-sourced DSH follow-up containing the exact Claude slash-command line, so the ordinary DSH turn, status, cancellation, persistence, approval, and adapter path remain the sole execution owner.
- Invalid command names are excluded with a bounded diagnostic; command metadata is never treated as trusted HTML.
- Catalog discovery failure is non-fatal to ordinary prompts and is retried on the next metadata refresh.

The plugin may provide a plugin-owned context refresh command, but must not shadow an existing DSH command. Claude commands that are local-only or produce no assistant text still complete through the ordinary turn boundary without synthesizing model output.

## 4. Permission Contract

`canUseTool(toolName, input, context)` performs:

1. write permission-pending sidecar activity with a stable tool-use id
2. derive a bounded human-readable reason and activity detail
3. call `ctx.approval.request({ agent, toolName, callId?, reason, signal })`
4. map `allowed-once` to `{ behavior: 'allow', updatedInput: input }`
5. map rejected/cancelled/unavailable to `{ behavior: 'deny', message }`
6. write the resulting sidecar permission activity

The native DSH access selector remains the sole write path and its `sandbox/mode` event is the sole durable source of truth. The supervisor folds that event at Query creation, before every turn or metadata operation, and before and after each approval request, mapping `read-only` to Claude `plan`, `workspace-write` to `acceptEdits`, and `danger-full-access` to `bypassPermissions`. If the user explicitly selects Full access while an approval request is open, the newest durable mode overrides the stale request being closed as rejected or cancelled. The native UI already requires explicit risk acknowledgement before Full access.

The plugin keeps `canUseTool` active for modes where Claude requests approval. `bypassPermissions` skips those SDK requests only after the user selects DSH Full access. A missing or invalid sandbox event fails safe to `plan`. This is Claude behavior mapping, not kernel confinement of the Claude subprocess.

### 4.1 User-question contract

Claude `AskUserQuestion` is an interaction, not an approval. `canUseTool` must route it before approval or Full access handling, map its bounded `questions` array to `ctx.userQuestions.ask({ questions, agent, signal })`, wait for the native DSH answer, and return an SDK allow result whose `updatedInput` preserves the original questions and adds Claude's required `answers` object keyed by question text. Multi-select values are comma-separated labels; DSH custom text replaces a single-select choice and supplements multi-select labels.

Full access never bypasses a user question. Missing active-turn ownership, malformed or duplicate questions, native provider failure, cancellation, and abort all fail closed with an SDK deny result. Sidecar activity may record only pending/completed/cancelled state and bounded question prompts; it must never persist the user's selected labels or custom text. Ordinary tools continue through `ctx.approval` unchanged.

## 5. Client Components

### 5.1 Conversation projection

Register one session-scoped projection source through the public Client session provider. The source fetches the same-origin trusted Host endpoint immediately when its first subscriber mounts and polls every two seconds only while subscribed. It validates the response before publication, notifies only on revision changes, and aborts requests and timers when the session unmounts. Failures degrade to an empty projection and never block the conversation.

The Host endpoint accepts trusted loopback/same-origin GET requests with a bounded encoded session id. It returns schema version, revision, activities, context usage, and tasks with non-cacheable headers. It never exposes the sidecar binding or Claude resume identity.

A lightweight `ConversationNodeDefinition` starts exactly once at each standard `turn/start` and marks that turn through updates from standard `assistant/message` events whose provider is `claude`. This keeps multi-step turns replay-safe while publishing location data only for Claude-owned turns. A second step-scoped Definition materializes one keyed `chat` node for each Claude assistant step, anchored immediately before that assistant message; its public `conversation.chat.node` renderer folds only the matching sidecar `turn` and `step` into ordered DSH `DisclosureRow` activity rows. The `conversation.chat.turnTail` contribution is task-launcher-only and never renders activity after the closing answer. When a task is first observed during an active turn, its bounded task snapshot retains that origin turn so the matching tail shows a running, completed, or failed launcher for as long as that task remains in the canonical snapshot. Tasks without a known origin turn are not given a detached global UI entry.

### 5.2 Activity card

The activity card shows:

- running/completed/error status
- thinking summary when supplied by Claude
- tool name and bounded input summary
- permission pending/allowed/denied state
- bounded result summary and error state
- subagent activity when represented in SDK messages
- tokens and cost when supplied

Do not render raw JSON by default. An expand control may show already-redacted detail. Use DSH theme tokens and existing primitive styles; no private shell modification.

### 5.3 Background tasks panel

Register a Claude turn-tail launcher only when that turn owns tasks in the latest sidecar snapshot; do not keep a permanent session-header Tasks control. The launcher reflects running, completed, or failed state and opens the DSH details column scoped to that origin turn. The panel groups that turn's tasks into Running and Finished sections and shows bounded description, task/agent type, status, duration, tokens, tool-use count, last tool, and summary when supplied.

Finished tasks may be collapsed and cleared from the mounted Client view. Clear is deliberately local presentation state: it does not mutate or falsify the canonical sidecar snapshot, and a newly observed settled task remains visible. “View activity” filters only already-redacted sidecar activity by the bounded task id; it never reads Claude transcript paths or exposes the resume identity.

The pinned Agent SDK and DSH public session face expose whole-turn interruption only. The panel must not present a per-task Stop control. Whole-turn cancellation remains the native DSH composer Stop action.

### 5.4 Context meter

Register an additive `conversation.input.right` entry so the meter appears between the model selector and send button without replacing the native composer. Its compact trigger is a circular percentage indicator. Activating it opens a theme-token-based panel showing:

- used percentage
- total tokens and context-window maximum
- a segmented category bar
- category rows for the aggregate SDK categories

The session-owned sidecar projection supplies the latest context sample, so refresh and Host restart preserve the last known meter. Refresh usage after Query initialization and after each completed Claude turn. While no sample exists, render nothing; metadata or projection failure must not block prompting. The component must not display excluded paths, tool identities, prompt content, or secrets.

### 5.5 Settings, Doctor, and updates

Add a settings section with:

- executable path
- default model alias (`default`, `opus[1m]`, `fable`, `sonnet`, `haiku`)
- idle timeout
- maximum live processes
- redacted Doctor output and rerun action
- npm release discovery and an in-place update action for uniquely identified registry installations

Persist settings through the plugin's own settings namespace if the DSH public settings seam supports out-of-tree schemas. If not, keep v0.1 configuration in the bundle row and expose Doctor read-only; do not invent an unmanaged credentials file. Plugin updates must install the registry's validated latest version explicitly rather than relying on the profile's existing semver range, then verify both the profile dependency and installed package manifests before reporting success. Linked, ambiguous, and unsupported sources remain non-updatable.

## 6. Failure and Recovery

| Failure | Required behavior |
| --- | --- |
| executable missing | Doctor and request fail with searched paths and repair instruction |
| CLI not authenticated | fail with `claude auth login` instruction; no browser auth proxy |
| initialization timeout | terminate tree; report handshake timeout |
| malformed SDK/CLI message | preserve bounded diagnostic, terminate affected process, fail turn |
| permission answer unavailable | deny action and continue Claude turn where possible |
| user cancels | call query interrupt, then terminate tree if not quiescent |
| process exits while idle | mark disconnected; resume on next prompt |
| process exits mid-turn after activity | persist a sidecar outcome-unknown error; never replay prompt automatically |
| persisted Claude session missing | fail explicitly with option to start a new DSH conversation; no silent context reset |
| process limit reached | evict least-recently-idle entry, otherwise fail with active-session count |
| plugin unload | terminate and await all owned trees |

## 7. Compatibility

- Target installed DSH `0.1.0-rc.5` public package surfaces.
- Keep peer dependency ranges broad enough for compatible rc updates but test against the installed host.
- Never import DSH internal source paths or copy `dsh-agent-loop` implementation.
- Use public agent request waterfall, LLM adapter, subprocess, approval, Web prefix route, per-agent command registry, session provider, client conversation projection, and additive input-slot APIs.
- Never depend on runtime mutation of DSH's persisted event vocabulary.
- A DSH upgrade that removes any required public seam must fail at plugin activation with a named compatibility diagnostic.

## 8. Verification and Acceptance

### 8.1 Automated

- executable resolution and version parsing
- exact-version plugin updates, post-install manifest verification, and no-op update rejection
- newest-direct-message resolution for text-only, pure-image, interleaved text/image, and multiple-image input
- attachment media/count/byte/pixel/dimension limits, verified reads, bounded errors, and cancellation
- stream mapping without duplicate text
- activity normalization, truncation, and redaction
- sidecar binding persistence, legacy-event import, and resume selection
- permission allow/deny/cancel/unavailable mapping
- process supervisor serialization, cancellation, idle eviction, process cap, crash classification, and disposal
- SDK message fixtures for init, partial text, tool use/result, permission, usage, success, failure, and malformed input
- command catalog reconciliation, aliases, DSH-name collision prefixing, follow-up delivery, and disposal
- context-usage normalization, safe-field sidecar persistence, latest-sample projection, and meter rendering
- trusted projection route, Client initial load/polling/cleanup/failure degradation, per-step chat-node ordering, and task-launcher turn-tail selectors
- Desktop cold-load of a newly produced session with no `claude-code/*` events
- typecheck Host and Client builds
- bundle build and package contents check

### 8.2 Local integration

- link-install into the current Web profile
- verify existing native preset session still works
- create a Claude preset session
- run text-only, pure-image, interleaved text/image, and multiple-image prompts
- reject one unreadable or over-limit image without starting a Claude turn or exposing attachment data
- run a file-edit prompt and approve once in DSH
- deny a Bash prompt and confirm Claude receives the denial
- cancel a running prompt and confirm no orphan process
- refresh the page and continue the same live session
- restart DSH and resume the persisted Claude session
- idle-evict and resume
- type `/` and verify Claude Skills/Commands are discoverable with DSH collisions prefixed
- execute one Claude Skill and confirm it runs as an ordinary DSH turn with activity and approval behavior intact
- verify the context meter beside model selection initializes, updates after a turn, opens its aggregate breakdown, and survives refresh
- run Doctor with the detected `~/.local/bin/claude` path

### 8.3 Completion evidence

The plugin is complete only when automated checks pass and the local linked profile demonstrates native/Claude coexistence, streaming, approval, cancellation, and resume without leaked processes or credentials.

## 9. Retirement / Future Work

Future work may:

- replace the LLM-seam bridge with a keyed DSH AgentFactory if DSH adds that public contract
- add explicit runtime state roots to DSH sandbox policy and enable kernel confinement
- verify Linux and Windows
- publish the bundle to npm

No compatibility fallback should copy the native DSH agent loop or silently downgrade Claude sessions to the native model route.
