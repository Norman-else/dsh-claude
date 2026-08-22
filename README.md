# dsh-claude

Run the local Claude Code CLI as a first-class main conversation inside DeepSeek Harness (DSH).

`dsh-claude` does not recreate Claude Code with an API client. It starts the user's installed `claude` executable through the official Agent SDK protocol, keeps one live process per active DSH session, and leaves Claude Code in charge of its own agent loop, tools, `CLAUDE.md`, Skills, Hooks, Plugins, MCP servers, settings, and authentication.

## What it adds

- A `Claude` Agent Preset in the normal new-session preset picker.
- A `claude` DSH model provider with Claude Code's `default`, `opus[1m]`, `fable`, `sonnet`, and `haiku` choices.
- Long-lived Claude processes with per-session serialization, idle eviction, cancellation, and persisted Claude session resume.
- DSH approval prompts for Claude tool permission requests and native DSH question forms for Claude clarifications.
- Durable, redacted plugin-sidecar activity for thinking summaries, tool calls/results, permissions, question lifecycle, subagents, status, usage, and errors.
- Native turn-tail activity cards and a Settings → Claude Code Doctor panel.
- A safe CLI for Doctor and managed preset install/remove.

## Requirements

- macOS (v0.1 verification target).
- DeepSeek Harness Desktop public plugin APIs on the `0.1.1-rc.2` package line.
- A local Claude Code installation already authenticated by the user.
- Node.js 20 or later.

The plugin never manages Claude credentials. Use an already authenticated local Claude Code installation, or configure its absolute executable path in DSH.

## Install in DSH

Install the published package into the DSH Web profile:

```sh
dsh plugin --profile web add @norman-else/dsh-claude
```

Wait for the Web profile to rebuild, then refresh the existing DSH page. Open a new conversation and select **Claude** from the Agent Preset picker.

The package ships a read-only system preset and, during Host activation, installs a protected compatibility copy at `$DSH_HOME/.agent-presets/claude`. The compatibility copy is required because supported DSH release-candidate builds replace third-party preset roots during profile boot. Installation is idempotent and never overwrites user-modified preset content.

## Use

1. Open a new DSH conversation.
2. Choose **Claude** in the Agent Preset picker.
3. Choose **Default (recommended)**, **Opus (1M context)**, **Fable**, **Sonnet**, or **Haiku**.
4. Send a normal text prompt.
5. Answer Claude tool permissions through the existing DSH approval UI and Claude clarifying questions through DSH's native question form.
6. Expand **Claude Code activity** beneath a completed assistant turn to inspect the redacted execution trail.

Native DSH presets remain available and keep the native DSH agent loop.

### Current input boundary

v0.1 forwards only the newest direct human text in a DSH step. It intentionally ignores the DSH system prompt, DSH tool schemas, and injected plugin messages because Claude Code owns those surfaces. Image-only prompts are rejected with an actionable error.

## Permission and sandbox boundary

Claude Code runs in its normal local configuration and can read/write `~/.claude` so that authentication, settings, plugins, and session recovery continue to work.

Every Claude permission callback is bridged to `ctx.approval.request(...)`:

- `allowed-once` is the only granting result.
- reject, cancel, missing answerer, and audit failure all deny the action.
- DSH `never` approval policy therefore fails closed.
- DSH access modes map to Claude permission modes: `read-only` → `plan`, `workspace-write` → `acceptEdits`, and explicitly acknowledged `danger-full-access` → `bypassPermissions`.
- Claude `AskUserQuestion` is always routed to `ctx.userQuestions`, including under Full access; cancellation or an unavailable question surface denies the interaction, and answer content is not copied into the sidecar.

This is a permission-policy bridge, not kernel-level workspace confinement. The supported DSH Desktop contract exposes one writable sandbox root, while full Claude compatibility also requires writable `~/.claude`. The plugin therefore does **not** claim that paths outside the workspace are technically unwritable. It still uses DSH managed subprocess ownership for explicit argv, credential-shaped environment scrubbing, cancellation, and whole-process-tree termination.

## Process and recovery behavior

- One live streaming-input Claude query per active DSH session.
- One active top-level turn at a time per session.
- Default maximum: 4 live Claude processes.
- Default idle eviction: 30 minutes.
- The Claude session id and redacted presentation metadata are persisted in a plugin-owned sidecar under `$DSH_HOME/plugins/dsh-claude/sessions`; new DSH logs contain no `claude-code/*` events.
- After normal eviction or DSH restart, the next prompt resumes that Claude session.
- A crash after visible Claude/tool activity is reported as **outcome unknown**. The plugin never automatically replays that prompt because its side effects may already have happened.
- Cancelling a DSH turn interrupts Claude and tears down that session's process entry (bounded interrupt, then close/abort/terminate/join); the next prompt re-establishes the process from the persisted Claude session id. Plugin unload and agent disposal also terminate the owned process tree.
- DSH outer model retries are disabled for this provider.

## Doctor

Inside DSH, open **Settings → Claude Code** and run Doctor.

From the checkout:

```sh
node lib/bin.mjs doctor
node lib/bin.mjs doctor --executable /absolute/path/to/claude
```

Doctor reports only the resolved executable, version, coarse authentication category/method/provider/subscription, handshake state, configured limits, and process count. It never returns tokens, email, organization id, settings content, or environment secrets.

Executable resolution order:

1. configured absolute path
2. `claude` on DSH's scrubbed PATH
3. `~/.local/bin/claude`
4. `/opt/homebrew/bin/claude`
5. `/usr/local/bin/claude`

To configure a nonstandard path, edit the plugin row in the Web profile composition:

```yaml
- id: llm-claude
  name: '@norman-else/dsh-claude'
  config:
    executablePath: /absolute/path/to/claude
    model: default
    idleTimeoutMs: 1800000
    maxProcesses: 4
```

## Development

```sh
git clone https://github.com/Norman-else/dsh-claude.git
cd dsh-claude
export PATH="/opt/homebrew/bin:$PATH"
pnpm install
pnpm check
```

To test this source checkout in DSH without publishing it:

```sh
dsh plugin --profile web add "link:$(pwd)"
```

To inspect the package that would be published:

```sh
pnpm pack --pack-destination ./dist-pack
```

### Release

Update the version in `package.json`, commit it, and push the clean release commit first. Then verify and publish both npm and GitHub releases:

```sh
pnpm release:check
pnpm release
```

The release script requires `HEAD` to match the current branch on `origin`. It runs the full project check and npm package preview, publishes the public npm package, waits for npm metadata propagation, verifies npm's `gitHead`, and creates a matching `v<version>` GitHub Release with generated notes. It is safe to rerun after a partial failure: an existing npm version or GitHub Release is accepted only when it points to the current commit.

The project uses fixture/state-machine tests and a minimal SDK-level handshake probe (a tool-disabled, one-turn `query()` against the resolved local executable). Full DSH-linked live acceptance (native coexistence, Claude turn, permission allow/deny, cancel, resume, orphan-process check) is run after the Host restart per `INSTALL.md`. The Agent SDK is pinned to `0.3.233`; runtime execution is forced to the resolved local Claude executable through `pathToClaudeCodeExecutable`.

## Uninstall

Remove the managed compatibility preset before removing the package:

```sh
dsh plugin --profile web exec dsh-claude remove-preset
dsh plugin --profile web remove @norman-else/dsh-claude
```

DSH does not expose a plugin uninstall lifecycle hook, so removing the package directly can leave `$DSH_HOME/.agent-presets/claude` behind. If the package was already removed, clean it up without cloning the source repository by running the matching installed version through npm:

```sh
pnpm dlx @norman-else/dsh-claude@<version> remove-preset
```

Both cleanup paths remove only installer-managed content. They fail without deleting anything if a preset file was user-modified; preserve or remove that custom content manually after review.

## Troubleshooting

### Claude preset appears broken

Confirm the package remains installed in the intended profile with `dsh plugin --profile web why @norman-else/dsh-claude`, then restart that profile so Host activation can install or refresh the protected managed preset. You can also run `dsh plugin --profile web exec dsh-claude install-preset` explicitly.

### Executable is missing

Run Doctor and set an absolute `executablePath`. GUI application PATH often omits `~/.local/bin`.

### Claude is signed out

Run the supported local flow directly:

```sh
/absolute/path/to/claude auth login
```

DSH does not proxy login or store credentials.

### A turn says “outcome unknown”

Inspect the activity record and workspace before sending a new instruction. Do not repeat a potentially side-effecting prompt blindly.

## Architecture records

- Product and architecture spec: `docs/aegis/spec/2026-08-15-dsh-claude-spec.md`
- Implementation plan: `docs/aegis/plan/2026-08-15-dsh-claude-implementation-plan.md`
