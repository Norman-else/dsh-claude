# Installation and removal runbook

Current guidance: 2026-09-14, plugin 0.1.51, development graph DSH 0.1.5-rc.2.

## 1. Identify the running installation

Use the DSH CLI supplied by the installation you intend to modify. Determine
its active profile before installing: the local Desktop setup uses `desktop`;
a standalone Web setup may use `web`. Do not create another profile or server
to compensate for a command aimed at the wrong one. No port is assumed here.

Examples below use `desktop`; substitute the actual profile throughout.
If `dsh` is not on PATH, use that installation's CLI entry point instead.

## 2. Install from npm

```sh
dsh plugin --profile desktop add @norman-else/dsh-claude
```

Wait for the profile operation to finish, then quit Desktop completely and
reopen it. Select **Claude** in a new session. The package's bundle patch
declares the preset (Desktop 2.0.15 / Host 0.1.7 or later); its route uses the
active profile package source.

## 3. Install from a source checkout

Requires Node.js 20 or later and pnpm. From the checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
```

On macOS, prepend `/opt/homebrew/bin` to PATH if that is where pnpm is installed.
PowerShell does not use the POSIX `PATH=... command` syntax.

If this checkout is already linked to a running profile, finish active turns
before rebuilding it. A build can trigger a live client reload and interrupt
projection subscriptions. During active work, validate in a separate source
copy with its own dependencies; do not copy its build into the live checkout.
After a deliberate live rebuild, fully restart Desktop to verify activation.

Link from PowerShell:

```powershell
dsh plugin --profile desktop add "link:$($PWD.Path.Replace('\', '/'))"
```

Or from a POSIX shell:

```sh
dsh plugin --profile desktop add "link:$(pwd)"
```

## 4. Check the local Claude CLI

Claude Code owns authentication. Use its existing login or supported settings
configuration; never request, copy, print, or store credentials in this plugin.

```sh
node lib/bin.mjs doctor
```

If discovery fails, use `doctor --executable` with the absolute native Claude
executable path. The standalone CLI's path search is simpler than the Host
resolver; on Windows prefer the native executable over an npm `.cmd` shim.

Read each report field. A zero exit code from the standalone Doctor establishes
version detection, not authenticated query success; its handshake is `not-run`.
An `unknown` authentication report is inconclusive. Use Settings/Doctor inside
DSH and a minimal real turn to verify the installed environment.

Main turns, session titles, and branch summaries load `user`, `project`, and
`local` settings. Summary calls also inherit behavior settings and use their
own working directory (`process.cwd()`), not a borrowed session process.

## 5. Smoke test after a full Desktop restart

1. Confirm **Claude** appears in the new-session preset picker.
2. Verify an existing native preset still works.
3. Send a minimal read-only Claude prompt; confirm streaming, final output, and title.
4. Under an access mode that requires approval, exercise deny and allow-once
   with a harmless temporary edit. Full access intentionally bypasses ordinary approvals.
5. Test a user question and plan review; both must remain available under Full access.
6. Stop a running turn, then send another prompt; confirm cleanup and continuity.
7. Restart Desktop and continue the same conversation to verify resume.
8. Open diff, plan, tasks, and overview tabs in the right sidebar; exercise
   fullscreen and close. Check command completion, prompt controls, and queue UI.
9. In a disposable repository, verify worktree creation and naming. Preserve
   needed changes before deleting its workspace: managed-worktree reconciliation
   can remove dirty files. Merged-branch cleanup is a separate guarded action.
10. Read the new Host log for `dsh-claude client [boot-check]`,
    `[slot-entry-crashed]`, and plugin refresh failures.

On the current Windows Desktop, Host logs are under
`%APPDATA%/DSH Desktop/logs/host/`; shell startup logs are one directory above.
Record what was actually exercised. A source audit or green unit tests do not
establish successful real authentication, approval, streaming, or resume.

## 6. Remove the plugin

The bundle patch declares the preset, so removing the package removes it:

```sh
dsh plugin --profile desktop remove @norman-else/dsh-claude
```

Plugin 0.1.57 and earlier also wrote a compatibility copy to
`$DSH_HOME/.agent-presets/claude`, which Host 0.1.7 no longer reads. Delete it
while the package is still installed:

```sh
dsh plugin --profile desktop exec dsh-claude remove-preset
```

Cleanup refuses user-modified presets; review them manually rather than forcing
removal. Restart Desktop after uninstalling. Removing the plugin does not mean
all Claude transcripts, sidecars, settings, or worktrees have been deleted.
