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
- **Managed preset compatibility** — Installs a guarded Claude preset whose route reuses the active profile package source, preserving discovery on DSH Desktop 2.0.4 without duplicate client-module Loaders or overwriting user changes.

## 4. Contributing

### 4.1 The two contribution types

Every contribution to this repository is exactly one of two types. There is no third type.

| Type | Means | Examples |
| --- | --- | --- |
| `feature` | Behavior that does not exist yet | A new composer action, a new Settings field, support for a new Claude Code capability, a documented behavior that was never written down |
| `fix` | Behavior that already exists but is wrong | A crashing slot entry, a wrong token count, a preset that stops being discovered after a Desktop upgrade, a README statement that no longer matches the code |

Refactors, dependency bumps, test-only changes, and documentation edits are not separate types. File them as the type that matches their purpose: something that is wrong today is a `fix`, something that does not exist today is a `feature`. If you cannot decide which one applies, that is a signal the issue is not scoped yet — open it as a question first and let the maintainer classify it.

### 4.2 Required flow

An issue always comes first. Pull requests that arrive without one are closed unreviewed, regardless of the quality of the code.

1. **Search existing issues.** If your problem or idea is already filed, comment there instead of opening a duplicate.
2. **Open an issue** at https://github.com/Norman-else/dsh-claude/issues/new/choose and pick the **Feature** or **Fix** form. Choosing the form is how you declare the type: it sets the `[feature]` / `[fix]` title prefix and the matching label for you. Every field listed in §4.3 is required by the form, so an issue that does not explain why it is needed or in what environment it happens cannot be submitted. Blank issues are disabled — if you genuinely cannot tell which type applies, use the "Not sure whether it is a feature or a fix" link on that page and let the maintainer classify it rather than guessing a type to get past the form.
3. **Wait for the issue to be accepted.** The maintainer confirms the type, the scope, and whether the change belongs in this plugin at all — several things that look like plugin bugs are DSH Host or Claude Code CLI behavior. Do not start implementation before this. Work done on a rejected issue cannot be merged.
4. **Branch from `master`** using `feature/<issue-number>-<short-slug>` or `fix/<issue-number>-<short-slug>`.
5. **Implement and verify** against the rules in §4.4.
6. **Open a pull request** that declares its type and links its issue (§4.5).
7. **Address review.** The maintainer reviews and approves; the maintainer merges. Contributors do not merge their own pull requests.

`master` is protected: direct pushes, force pushes, and branch deletion are blocked, and a pull request needs one approving review before it can merge. Pushing new commits to a pull request dismisses any existing approval, so expect to request review again after changes.

### 4.3 What the issue must contain

Both types require enough detail for someone else to reproduce your situation without asking you follow-up questions.

**A `feature` issue must state:**

- **Motivation** — what a DSH user cannot do today, and why the current workaround is not good enough.
- **Proposed behavior** — what should happen, described from the user's side, naming the surface it belongs to (composer, hero repository controls, diff panel, activity timeline, Settings panel, Agent Preset picker, …).
- **Scope and non-goals** — what this explicitly does not cover, so the pull request can be reviewed against a fixed boundary.
- **Affected layer** — plugin server (`src/`), client (`src/client/`), managed preset (`preset/`), or a combination.
- **Compatibility** — the DSH Desktop and DSH package line it targets, and the Claude Code CLI version it relies on. Say so if it depends on a Claude Code capability that older CLI versions do not have.
- **Alternatives considered** — including "do nothing", and why they were rejected.
- **Whether you intend to implement it** — so the maintainer knows whether to assign it to you or to schedule it.

**A `fix` issue must state:**

- **Expected behavior vs. actual behavior** — two separate sentences, not one combined complaint.
- **Reproduction steps** — numbered, minimal, and starting from a clean state. Say whether it reproduces every time or intermittently.
- **Environment** — plugin version (the `version` field in `package.json`, or the version DSH shows), DSH Desktop version, Claude Code CLI version, operating system, and Node.js version if you installed from source.
- **Evidence** — the relevant redacted log lines, activity-timeline excerpt, or screenshot. Boot and slot failures surface in the DSH log as `dsh-claude client [boot-check]` and `[slot-entry-crashed]`; include those lines when the plugin fails to load.
- **Regression range** — the last plugin or DSH Desktop version where it worked, if you know it.

**Redact before you post.** Never paste Claude credentials, API keys, session tokens, private repository contents, or customer data into an issue, a pull request, a test fixture, or a log excerpt. This applies to attachments and screenshots as well. The plugin never asks for or stores Claude credentials, and neither should its issue tracker.

### 4.4 Rules for the change itself

- **Stay out-of-tree.** Use only public DSH exports. Never patch the installed DSH checkout, and never depend on DSH internals that are not exported.
- **Respect the ownership split.** Claude Code owns its agent loop and tools; this plugin owns presentation, approval and question surfaces, and managed process lifetime. Changes that re-implement Claude Code behavior inside the plugin will be rejected.
- **Read the spec first** when you change runtime behavior: `docs/aegis/spec/2026-08-15-dsh-claude-spec.md` and the current plan under `docs/aegis/plan/` and `docs/aegis/plans/`. If you are reacting to a DSH Desktop upgrade, follow `docs/upgrading-dsh-desktop.md` — the Host ships no type declarations, so `pnpm typecheck` cannot see its API drift.
- **Never log, persist, render, or test with real credentials.** Redact before any durable event append.
- **Run `pnpm check`** — typecheck for both tsconfigs, the Vitest suite, and the build — and make sure it passes before you open the pull request. Do not claim a change works without it.
- **Cover behavior with tests** where the change is testable. A `fix` should come with a test that fails before the change and passes after it.
- **Keep one type per branch.** Do not mix a feature and a fix in the same pull request, even if you found them together — open two issues and two pull requests.
- **Leave releases alone.** Do not bump `version` in `package.json`, edit `scripts/publish.mjs`, or publish. Releases are maintainer-only via `pnpm release`.
- **Write commit subjects in the repository's existing style**: imperative mood, describing the intent rather than the mechanics, no `feat:` / `fix:` prefixes. See `git log` for the established pattern — for example, `Report the whole turn's output tokens, not the last call's`.

### 4.5 Pull request requirements

Open the pull request against `master` and include all of the following:

- **A `Type:` line as the first line of the description** — either `Type: feature` or `Type: fix`. This is how the contribution type is declared; a pull request without it is not reviewed.
- **A closing reference to its issue** — `Closes #<issue-number>`. A pull request that closes no issue does not get merged.
- **The matching label** — `feature` or `fix`, the same one carried by the issue.
- **What changed and how you verified it** — including the `pnpm check` result, and the manual verification you performed in DSH Desktop for anything that touches the UI or the process lifecycle.
- **A README update** when the change adds or alters user-visible behavior. New features belong in the Features list in §3.

The type is declared through the label and the `Type:` line rather than a title prefix so that squashed commit subjects stay in the repository's plain imperative style.

### 4.6 What gets rejected

- A pull request with no accepted issue behind it, or with no declared type.
- A feature and a fix bundled into one pull request.
- Changes that patch DSH, reach into non-public DSH APIs, or re-implement Claude Code's agent loop.
- A failing or unrun `pnpm check`.
- Anything that logs, persists, or renders credentials, including in tests and fixtures.
- Version bumps, release script edits, or publish attempts from a contribution branch.
