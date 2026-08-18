# dsh-claude-code Product and Architecture Spec

Status: approved design baseline with implementation discovery amendments
Date: 2026-08-15

## 1. Product / Requirement Baseline

### 1.1 Problem

DeepSeek Harness (DSH) can run its native agent loop and can expose external coding agents as delegated subagents, but it does not provide a first-class main-conversation experience backed by the user's already-installed local Claude Code CLI. The user wants to stay in the existing DSH Web profile, choose Claude Code for a new conversation, and retain Claude Code's own agent loop, tools, CLAUDE.md discovery, Skills, Hooks, Plugins, MCP configuration, authentication, and session behavior.

### 1.2 Goal

Ship an out-of-tree DSH bundle named `dsh-claude-code` that adds a `Claude Code CLI` Agent Preset to the current Web profile. A session using that preset routes each outer DSH model step into a complete Claude Code turn driven by the user's local CLI. DSH remains the conversation UI, durable presentation mirror, permission UI, process owner, and cancellation surface.

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
- DSH attachments/images forwarded into Claude Code.
- Background-agent continuation after the top-level Claude result.
- Publishing to npm before local installation and compatibility validation pass.
- Modifying DeepSeek Harness core APIs.

## 2. Architecture / Runtime Boundary Baseline

### 2.1 Integration shape

The plugin does not replace the process-global DSH `AgentFactory`. The Web profile keeps the native `dsh-agent-loop`. A plugin-provided Agent Preset contributes an `agent/request` waterfall listener that replaces the request route with the plugin's `claude-code-cli` provider. The provider's adapter turns one DSH model request into one complete Claude Code agent turn and emits only final assistant content back through the DSH LLM stream.

This is an agent bridge at the LLM seam, not a claim that Claude Code is a stateless LLM provider.

### 2.2 Canonical owners

| Surface | Canonical owner |
| --- | --- |
| DSH conversation identity, turn boundaries, standard assistant text | DSH session and native agent loop |
| Claude context, internal agent loop, tool selection/execution | Claude Code CLI |
| Local Claude auth, settings, CLAUDE.md, Skills, Hooks, Plugins, MCP | Existing Claude Code installation and `~/.claude` |
| Claude process lifetime and cancellation | Plugin process supervisor over DSH managed subprocess |
| Tool permission decision UI and audit | DSH approval service |
| Claude-to-DSH session binding | Plugin-owned durable DSH event |
| Claude internal activity presentation | Plugin-owned durable events and client projection |

### 2.3 Agent SDK amendment

Use `@anthropic-ai/claude-agent-sdk` only as the supported typed protocol/process adapter for the local CLI. Configure `pathToClaudeCodeExecutable` with the resolved absolute user executable and set `spawnClaudeCodeProcess` to a wrapper backed by `ctx.subprocess`. The SDK must not choose its optional bundled binary and must not authenticate independently.

Required SDK options include:

- `pathToClaudeCodeExecutable`: resolved local CLI path
- `systemPrompt: { type: 'preset', preset: 'claude_code' }`
- `settingSources: ['user', 'project', 'local']`
- `includePartialMessages: true`
- `permissionMode: 'default'`
- `canUseTool`: DSH approval bridge
- `cwd`: immutable DSH session cwd
- `resume`: persisted Claude session id when present
- explicit model only when the selected alias is not `default`
- `spawnClaudeCodeProcess`: DSH-managed process adapter

The version initially pinned for development is `@anthropic-ai/claude-agent-sdk@0.3.233`, aligned with the detected local Claude Code `2.1.233`. Runtime compatibility is feature-detected and diagnosed rather than inferred only from a version string.

### 2.4 Sandbox boundary amendment

The plugin reuses the DSH permission UI and maps DSH permission policy into Claude permission behavior, but v0.1 does not claim kernel-level workspace confinement.

Reason: DSH's current process sandbox permits writes only to the workspace and temporary roots, while full Claude Code semantics and durable resume require writes under `~/.claude`. The public sandbox contract has no additional technical-state-root vocabulary. Silently bypassing `~/.claude`, copying credentials, or widening the workspace root would each violate a more important boundary.

The process still runs through `ctx.subprocess` for explicit argv, credential-shaped ambient environment scrubbing, cancellation, and whole-process-tree cleanup. A future DSH core extension may add explicit runtime state roots; that is outside this plugin.

### 2.5 Same-profile routing

The bundle adds:

- one host adapter route: `claude-code-cli`
- one preset-scoped route plugin that overrides `agent/request` to `{ provider: 'claude-code-cli', model: <alias> }`
- one user-visible preset: `claude-code-cli`

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

- lazy start on first bridged request
- maintain a streaming-input Claude query while the DSH session is active
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

For ordinary conversation calls, extract the newest DSH user text that entered the current step. Do not resend the whole DSH history because Claude's session is the context source of truth. Reject unsupported image-only input in v0.1 with an actionable error.

DSH system prompts and tool schemas are not forwarded. Claude Code receives its own `claude_code` system prompt preset and local configuration.

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

### 3.5 Durable plugin events

Register runtime event vocabulary in `KNOWN_SESSION_EVENT_TYPES`.

`claude-code/session-bound`:

```ts
interface ClaudeSessionBoundEvent {
  claudeSessionId: string
  cliVersion?: string
  sdkVersion: string
  cwd: string
}
```

`claude-code/activity`:

```ts
type ClaudeActivityEvent = {
  turn: number
  step: number
  ordinal: number
  kind:
    | 'status'
    | 'thinking'
    | 'tool-call'
    | 'tool-result'
    | 'permission'
    | 'subagent'
    | 'usage'
    | 'warning'
    | 'error'
  phase?: 'started' | 'updated' | 'completed' | 'denied' | 'failed'
  toolUseId?: string
  toolName?: string
  title?: string
  summary?: string
  detail?: string
  isError?: boolean
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    costUsd?: number
  }
}
```

Payloads must be lossless JSON, bounded, and secret-aware. Input/output detail is truncated before persistence. Environment maps, credential-shaped keys, and known token fields are redacted rather than truncated.

## 4. Permission Contract

`canUseTool(toolName, input, context)` performs:

1. append permission-pending activity with a stable tool-use id
2. derive a bounded human-readable reason and activity detail
3. call `ctx.approval.request({ agent, toolName, callId?, reason, signal })`
4. map `allowed-once` to `{ behavior: 'allow', updatedInput: input }`
5. map rejected/cancelled/unavailable to `{ behavior: 'deny', message }`
6. append the resulting permission activity

DSH approval policy `never` fails closed. The plugin never turns `danger-full-access` into implicit Claude `bypassPermissions`; v0.1 keeps the callback active in every DSH mode.

The DSH public model-call contract does not carry a session sandbox-mode signal to this adapter, so v0.1 does not infer read-only/workspace-write behavior from prompts or ambient text. Claude stays in `default` permission mode and every SDK permission callback is bridged to DSH approval. This is policy mapping, not kernel confinement.

## 5. Client Components

### 5.1 Conversation projection

Register a `ConversationNodeDefinition` that:

- starts on `turn/start`
- consumes `claude-code/activity` events for the matching turn
- publishes turn data under `claudeCode`
- emits no independent chat node

Register a `conversation.chat.turnTail` chain entry whose selector claims only turns with Claude activity. The component renders an ordered collapsible activity list beneath the closing assistant message.

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

### 5.3 Settings and Doctor

Add a settings section with:

- executable path
- default model alias (`default`, `sonnet`, `opus`, `haiku`)
- idle timeout
- maximum live processes
- redacted Doctor output and rerun action

Persist settings through the plugin's own settings namespace if the DSH public settings seam supports out-of-tree schemas. If not, keep v0.1 configuration in the bundle row and expose Doctor read-only; do not invent an unmanaged credentials file.

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
| process exits mid-turn after activity | append outcome-unknown error; never replay prompt automatically |
| persisted Claude session missing | fail explicitly with option to start a new DSH conversation; no silent context reset |
| process limit reached | evict least-recently-idle entry, otherwise fail with active-session count |
| plugin unload | terminate and await all owned trees |

## 7. Compatibility

- Target installed DSH `0.1.0-rc.5` public package surfaces.
- Keep peer dependency ranges broad enough for compatible rc updates but test against the installed host.
- Never import DSH internal source paths or copy `dsh-agent-loop` implementation.
- Use public session event extension, agent request waterfall, LLM adapter, subprocess, approval, client conversation projection, and slot APIs.
- A DSH upgrade that removes any required public seam must fail at plugin activation with a named compatibility diagnostic.

## 8. Verification and Acceptance

### 8.1 Automated

- executable resolution and version parsing
- prompt extraction and unsupported-input failures
- stream mapping without duplicate text
- activity normalization, truncation, and redaction
- session-binding fold and resume selection
- permission allow/deny/cancel/unavailable mapping
- process supervisor serialization, cancellation, idle eviction, process cap, crash classification, and disposal
- SDK message fixtures for init, partial text, tool use/result, permission, usage, success, failure, and malformed input
- client conversation projection and selector
- typecheck Host and Client builds
- bundle build and package contents check

### 8.2 Local integration

- link-install into the current Web profile
- verify existing native preset session still works
- create a Claude preset session
- run a read-only prompt
- run a file-edit prompt and approve once in DSH
- deny a Bash prompt and confirm Claude receives the denial
- cancel a running prompt and confirm no orphan process
- refresh the page and continue the same live session
- restart DSH and resume the persisted Claude session
- idle-evict and resume
- run Doctor with the detected `~/.local/bin/claude` path

### 8.3 Completion evidence

The plugin is complete only when automated checks pass and the local linked profile demonstrates native/Claude coexistence, streaming, approval, cancellation, and resume without leaked processes or credentials.

## 9. Retirement / Future Work

Future work may:

- replace the LLM-seam bridge with a keyed DSH AgentFactory if DSH adds that public contract
- add explicit runtime state roots to DSH sandbox policy and enable kernel confinement
- support attachments and image inputs
- verify Linux and Windows
- publish the bundle to npm

No compatibility fallback should copy the native DSH agent loop or silently downgrade Claude sessions to the native model route.
