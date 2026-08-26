# dsh-claude

## 1. Overview

`dsh-claude` runs the locally installed Claude Code CLI as a first-class conversation provider inside DeepSeek Harness (DSH). It uses Claude Code's official Agent SDK protocol instead of recreating the agent with a separate API client.

Claude Code remains responsible for its agent loop, tools, `CLAUDE.md`, Skills, Hooks, Plugins, MCP servers, settings, and authentication. DSH provides the conversation UI, approval and question surfaces, repository workflow, activity presentation, and managed process lifetime.

## 2. Installation and removal

### Requirements

- DeepSeek Harness Desktop with compatible public plugin APIs. This package is currently developed against the DSH `0.1.1-rc.2` package line.
- A local Claude Code installation that is already authenticated.
- Node.js 20 or later when installing from a source checkout.

The plugin never asks for or stores Claude credentials. Authenticate through the local Claude Code CLI before using the plugin.

### Install from npm

Add the published package to the DSH Web profile:

```sh
dsh plugin --profile web add @norman-else/dsh-claude
```

Wait for the profile rebuild to finish, then restart DSH Desktop if requested. Create a new conversation and select **Claude** from the Agent Preset picker.

### Install from source

```sh
git clone https://github.com/Norman-else/dsh-claude.git
cd dsh-claude
pnpm install
pnpm check
```

Link the checkout to DSH from PowerShell:

```powershell
dsh plugin --profile web add "link:$PWD"
```

Or from macOS/Linux:

```sh
dsh plugin --profile web add "link:$(pwd)"
```

### Remove the plugin

Remove the managed compatibility preset before removing the package:

```sh
dsh plugin --profile web exec dsh-claude remove-preset
dsh plugin --profile web remove @norman-else/dsh-claude
```

DSH does not currently expose a plugin uninstall lifecycle hook. If the package was removed before its managed preset was cleaned up, run the matching installed version directly:

```sh
pnpm dlx @norman-else/dsh-claude@<version> remove-preset
```

Preset cleanup removes only installer-managed content and refuses to delete user-modified preset files.

## 3. Features

- **Native Claude Code conversations** — Runs Claude Code as the main agent in a normal DSH conversation instead of wrapping it as a tool or secondary chat.
- **Claude preset and model selection** — Adds a `Claude` Agent Preset and exposes Claude Code's `default`, `opus[1m]`, `fable`, `sonnet`, and `haiku` model choices.
- **Local Claude environment compatibility** — Preserves the user's existing Claude Code authentication, settings, `CLAUDE.md`, Skills, Hooks, Plugins, tools, and MCP configuration.
- **Real-time streaming and conversation continuity** — Streams Claude responses and tool activity into DSH while retaining multi-turn context and persisted Claude session resume.
- **DSH permissions and questions** — Routes Claude tool permission requests through DSH approvals and Claude clarification prompts through DSH's native question forms.
- **Managed process lifecycle** — Keeps one live Claude process per active session, serializes turns, evicts idle processes, and handles Stop, cancellation, restart, and process-tree cleanup.
- **Redacted activity timeline** — Displays thinking summaries, tool calls and results, permission events, questions, status changes, usage, errors, and subagent activity without persisting credentials.
- **Background task tracking** — Shows running and completed Claude subagents or background tasks with task status, recent tools, and expandable activity.
- **Repository and worktree preparation** — Lets a user choose a branch before submitting, switch an eligible local branch, or create a dedicated Git worktree and DSH workspace while transferring the current draft and attachments, and removes a worktree's directory automatically once its workspace is deleted and the tree is clean.
- **Repository and pull request status** — Shows the current repository, branch, worktree state, changed-line counts, unpushed commits, GitHub pull request, checks, review state, merge state, and blocking Claude rate limits near the composer.
- **Diff viewer and review comments** — Provides an expandable or maximized branch diff, including file statistics and line-level review comments that are attached to the next Claude message.
- **Commit, push, and pull request actions** — Supports Commit, Commit & Push, Push, and draft pull request creation, with repository snapshot validation and optional Claude-generated commit messages.
- **Claude Code settings and Doctor** — Adds a Settings panel for runtime diagnostics, supported Claude settings, worktree branch prefix, process limits, authentication and handshake status, and safe npm update checks.
- **Managed preset compatibility** — Installs an idempotent compatibility copy of the Claude preset for supported DSH builds without overwriting user-modified preset content.
