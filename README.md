# dsh-claude-code

Run the local Claude Code CLI as a first-class main conversation inside DeepSeek Harness (DSH).

`dsh-claude-code` does not recreate Claude Code with an API client. It starts the user's installed `claude` executable through the official Agent SDK protocol, keeps one live process per active DSH session, and leaves Claude Code in charge of its own agent loop, tools, `CLAUDE.md`, Skills, Hooks, Plugins, MCP servers, settings, and authentication.

## What it adds

- A `Claude Code CLI` Agent Preset in the normal new-session preset picker.
- A `claude-code-cli` DSH model provider with `default`, `sonnet`, `opus`, and `haiku` aliases.
- Long-lived Claude processes with per-session serialization, idle eviction, cancellation, and persisted Claude session resume.
- DSH approval prompts for Claude tool permission requests.
- Durable, redacted activity events for thinking summaries, tool calls/results, permissions, subagents, status, usage, and errors.
- Native turn-tail activity cards and a Settings → Claude Code Doctor panel.
- A safe CLI for Doctor and managed preset install/remove.

## Requirements

- macOS (v0.1 verification target).
- DeepSeek Harness compatible with `0.1.0-rc.5` public plugin APIs.
- A local Claude Code installation already authenticated by the user.
- Node.js and pnpm only for building/linking this source checkout.

The plugin never manages Claude credentials. The detected installation on the development host is `~/.local/bin/claude` version `2.1.233`.

## Install from this checkout

```sh
cd /Users/normanzuo/PersonalRepos/dsh-claude-code
export PATH="/opt/homebrew/bin:$PATH"
pnpm install
pnpm check

node "/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add "link:/Users/normanzuo/PersonalRepos/dsh-claude-code"
```

Refresh the existing DSH Web page at `http://127.0.0.1:56454` after the Web profile rebuild/reload completes. Do not start a replacement Web server.

The Host plugin automatically installs a two-file managed preset at:

```text
$DSH_HOME/.agent-presets/claude-code-cli/
```

It writes only absent files. If that preset id already contains different content, activation fails rather than overwriting user work.

## Use

1. Open a new DSH conversation.
2. Choose **Claude Code CLI** in the Agent Preset picker.
3. Choose `Claude Code Default` unless you explicitly want the Sonnet, Opus, or Haiku alias.
4. Send a normal text prompt.
5. Answer Claude tool permissions through the existing DSH approval UI.
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
- the plugin never enables Claude's `bypassPermissions` mode.

This is a permission-policy bridge, not kernel-level workspace confinement. DSH `0.1.0-rc.5` exposes one writable sandbox root, while full Claude compatibility also requires writable `~/.claude`. The plugin therefore does **not** claim that paths outside the workspace are technically unwritable. It still uses DSH managed subprocess ownership for explicit argv, credential-shaped environment scrubbing, cancellation, and whole-process-tree termination.

## Process and recovery behavior

- One live streaming-input Claude query per active DSH session.
- One active top-level turn at a time per session.
- Default maximum: 4 live Claude processes.
- Default idle eviction: 30 minutes.
- The Claude session id is persisted as a plugin-owned DSH session event.
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
- id: llm-claude-code-cli
  name: dsh-claude-code
  config:
    executablePath: /absolute/path/to/claude
    model: default
    idleTimeoutMs: 1800000
    maxProcesses: 4
```

## Development

```sh
export PATH="/opt/homebrew/bin:$PATH"
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination ./dist-pack
```

The project uses fixture/state-machine tests and a minimal SDK-level handshake probe (a tool-disabled, one-turn `query()` against the resolved local executable). Full DSH-linked live acceptance (native coexistence, Claude turn, permission allow/deny, cancel, resume, orphan-process check) is run after the Host restart per `INSTALL.md`. The Agent SDK is pinned to `0.3.233`; runtime execution is forced to the resolved local Claude executable through `pathToClaudeCodeExecutable`.

## Uninstall

Remove the managed preset while this package is still present:

```sh
node lib/bin.mjs remove-preset
```

Then remove the linked package from the Web profile:

```sh
node "/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web remove dsh-claude-code
```

The preset remover deletes only files whose contents exactly match the package-managed copies. It refuses to delete modified content.

## Troubleshooting

### Claude preset appears broken

Run `node lib/bin.mjs install-preset`. If it reports a conflict, move or rename the existing `$DSH_HOME/.agent-presets/claude-code-cli` directory; the plugin will not overwrite it.

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

- Product and architecture spec: `docs/aegis/spec/2026-08-15-dsh-claude-code-spec.md`
- Implementation plan: `docs/aegis/plan/2026-08-15-dsh-claude-code-implementation-plan.md`
