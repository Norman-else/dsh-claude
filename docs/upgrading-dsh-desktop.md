# Following a DSH Desktop upgrade

What to do when the Host moves under this package.

## Why this needs a runbook

The Desktop build ships **no type declarations**, and several of its client
packages (`@deepseek-ai/dsh-client-ui-chat` among them) are **not published to
npm at all**. `pnpm typecheck` therefore validates this package against whatever
`@deepseek-ai/*` versions happen to be in `node_modules` — never against the Host
it will actually run inside. During the Desktop 2.0 upgrade the installed
devDependencies were `0.1.1-rc.2` while the Host ran `0.1.2-alpha.1`; five
separate API breakages passed typecheck and the full test suite.

Worse, all five failed **silently**. A Slot entry that throws is caught by the
Host and dropped, the shipped Desktop opens no DevTools, and startup still
reports `rendererStatus: "healthy"`. The plugin rendered nothing while every
signal said it was fine.

So: compile-time checking cannot help here. Runtime assertions and the Host's own
source are the tools.

## 0. If Desktop will not start

Do this before anything else — everything below assumes a running app.

First confirm the plugin is the cause:

```bash
tail -50 "$APPDATA/DSH Desktop/logs/dsh-$(date +%F).error.log"
```

`RendererStartupFailure` naming `@norman-else/dsh-claude` means this package.
Without it, the fault is elsewhere and disabling the plugin will not help.

**Roll the checkout back.** The profile links the plugin as
`link:K:/PersonalWorkspace/dsh-claude`, so the running plugin *is* the working
tree — reverting the code reverts the plugin, with no DSH configuration
touched:

```bash
git checkout <last-known-good> && pnpm build
```

Restart Desktop. This is the fastest route and the one to try first.

**If that is not enough, unmount the plugin entirely.** Both edits are plain
config and fully reversible:

1. In `~/.dsh/profiles/desktop/package.json`, drop `"@norman-else/dsh-claude"`
   from `dsh.profile.bundles`. That list is what mounts bundles — `cordis.yml`
   can be empty while the plugin still loads.
2. Rename `~/.dsh/.agent-presets/claude/` aside. Its `agent.cordis.yml` names
   `@norman-else/dsh-claude/preset-route`, which stops resolving once the
   profile no longer carries the package, and could become a fresh startup
   failure of its own.

Restart, debug with the plugin disabled, then restore both.

Two honesty notes. Whether `RendererStartupFailure` is actually fatal was never
confirmed — `app.asar` was not unpacked to read the throw path, and during the
2.0 migration the window still opened while the renderer boot failed. And the
unmount procedure is derived from the profile layout rather than tested. The
rollback above is the verified path.

## 1. Let the plugin report first

Start Desktop, run one turn in a Claude session, then read the Host log:

```bash
grep "dsh-claude client" "$APPDATA/DSH Desktop/logs/dsh-$(date +%F).log"
```

Two kinds appear:

- `[boot-check]` — a declared service or a Host CSS custom property is gone.
  Emitted from `apply()` before anything else can fail.
- `[slot-entry-crashed]` — a UI entry threw; the line carries the slot key, the
  entry id, and the stack.

Both come from `src/client/boot-check.ts` and `src/client/client-diagnostics.ts`,
reaching the log through the plugin's own `/plugins/dsh-claude/client-diagnostics`
route. Silence plus working features means nothing drifted.

## 2. Treat the installed Host as the only source of truth

Read the real implementation, not `node_modules`:

```
E:\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\
```

Useful queries, all of which were needed for the 2.0 migration:

```bash
# Which package provides a service, and does the name still exist
grep -rl 'super(ctx, "uiConversation"' --include=client.js .

# Slot catalogue: key, doc, registerOptions, declaredBy, occupants, example
grep -n 'key: "conversation.chat.turnTail"' -A 30 dsh-cordis-client-runner/lib/client.js

# What a package declares it needs
python -c "import json;print(json.load(open('dsh-client-ui-goal/package.json'))['dsh']['client']['inject'])"
```

**Fastest single technique:** diff against a Host plugin that registers into the
same Slots. `dsh-client-ui-goal` and `dsh-client-ui-deliverables` overlap this
package almost exactly; comparing their `dsh.client.inject` is how the two
missing entries were found.

For a CSS question, read the rule from the running page rather than guessing —
CDP `CSS.getMatchedStylesForNode` gives the exact declaration.

## 3. Reading the renderer

DevTools shortcuts are disabled in the shipped build. Quit Desktop completely,
then:

```bash
"E:\DSH Desktop\DSH Desktop.exe" --remote-debugging-port=9222
```

Attach over CDP at `http://127.0.0.1:9222/json/list`. `Runtime.consoleAPICalled`
and `Runtime.exceptionThrown` carry the crashes; `Runtime.evaluate` measures the
live DOM, which is how the composer-width regression was confirmed.

The `DevToolsActivePort` file in the Desktop profile directory can be stale —
check that the port is actually listening before trusting it.

## 4. Two rules while iterating

- **Restart Desktop completely after every rebuild.** `patchReload: "live"` hot
  swaps the client bundle, and that tears down this plugin's rendering: nodes
  unmount, projection subscriptions drop, and nothing re-arms. A fix verified
  only through a hot reload will look like it failed.
- **Never rebuild while a turn is running.** The same hot swap cuts the live
  projection stream, and the in-flight turn never recovers its subscription.

## 5. Leave the next upgrade a better signal

When a fix lands, extend the automatic checks so the same class of drift reports
itself next time:

- New Host CSS custom property → add it to `CLAUDE_REQUIRED_CSS_VARIABLES` in
  `src/client/boot-check.ts`. `var(--x, fallback)` cannot distinguish "the Host
  stopped publishing this" from "the Host says this", so an unlisted property
  degrades silently and forever.
- New Host service → add it to `export const inject` in `src/client/index.tsx`;
  the boot check walks that list.

**Watch for tests that pin the bug.** Two of the 2.0 breakages were escorted
through the upgrade by green tests:
`client-repository-status.test.tsx` asserted the dead CSS variable name, and
`supervisor.test.ts` asserted the wrong reported output-token count. When an
assertion encodes a Host contract, re-derive it from the Host before trusting it.

## 6. The full audit, in order

The 2.0.5 upgrade showed that sections 1 and 2 are necessary but not
sufficient: a slot whose owner stopped passing a prop leaves a button
permanently disabled, and nothing crashes, so no log line ever appears. The
sequence below is what finally found everything. Run all of it; do not stop at
the first fix.

`H` below is the Host package directory from section 2.

**Step 1. Pin the development graph to the Host, then trust `tsc`.**

```bash
for p in "$H"/*/package.json; do node -e "const p=require('$p');console.log(p.name,p.version)"; done | sort -u -k2 | head
pnpm view @deepseek-ai/dsh-session versions --json | tail -3
```

If the Host version is on npm: bump every `@deepseek-ai/*` devDependency, the
`overrides` and `minimumReleaseAgeExclude` lists in `pnpm-workspace.yaml`, and
the expectation in `test/package-contract.test.ts`. Reinstall, then confirm the
installed copies are the Host's copies — this is what makes typecheck mean
something:

```bash
for p in dsh-session dsh-commands dsh-client-ui-chat dsh-client-ui-conversation; do
  diff -r -x '*.map' node_modules/@deepseek-ai/$p/lib "$H/$p/lib" | grep -cE '^[<>]'
done
```

Zero, or CSS-hash noise only (`\0dsh-css:` regions from a different build
machine), is the target. A transitive package that stays on the old version
despite the override (`pnpm peers check` names it) is fixed by adding it as an
explicit devDependency.

**Step 2. Diff the Host against what the plugin was built on.**

Before reinstalling, or from the old lockfile, diff each package the plugin
imports (`grep -rhoE "from '@deepseek-ai/[^']+'" src preset | sort -u`) and
read the JS changes with the typert declaration noise stripped:

```bash
diff -ru -x '*.map' node_modules/@deepseek-ai/$p/lib "$H/$p/lib" \
  | grep -v '"declaration"\|"name":\|sourceLocation' | grep -E '^[+-]'
```

Every removed or renamed export, method, getter, or field becomes a grep over
`src/` and `test/`. In 2.0.5 that was `Session.events` (six host-side reads),
`seedLength`, `effectiveApprovalPolicy`, and the `MessageSourceMap` kinds.

**Step 3. Owner props, slot by slot.** The Host decides per release what an
entry receives. For every key in `ctx.slots.inject(...)`:

```bash
grep -hoE 'renderSlot\("conversation.input.left", [^)]*\)' "$H"/dsh-client-ui-*/lib/client.js
```

`{}` means the entry gets standard props only (`useInput`, `useSession`,
`useSessions`, `useWorkspaces`, `useChat`, `useConversation`, `sessionId`,
`inputActions`); `zone` or a literal object is the owner currency. Compare with
what each component destructures (`grep -hoE "^export function Claude[A-Za-z]+\(\{[^}]*\}" src/client/*.tsx`).
Prefer the standard hooks: they are the stable channel, owner props are not.

**Step 4. Definitions, snapshots, services, symbols.** Four mechanical greps
against the Host bundles:

- Conversation definitions: `grep -o "definition\.[a-zA-Z]*" "$H"/dsh-client-ui-conversation/lib/client.js | sort -u`
  lists every hook the assembler calls; any new one must be optional-chained
  (`definition.publication?.(...)`) or the plugin's definitions must gain it.
- Snapshot fields the client reads (`running`, `blank`, `displayTitle`, `cwd`,
  `origin`, `sessionIds`, `workspaceId`, `current`): grep each in
  `dsh-api-session-controller` and `dsh-api-workspace-controller`.
- Client service methods (`sessions.scope/open/binding`, `workspaces.*`,
  `uiConversation.events.register`, `conversation.input.for/updateQueue`,
  `remote.agentPresets.select`): grep the method name in the bundles.
- Every runtime symbol imported from a Host package: extract the import lists,
  grep each name in that package's `lib/*.js`. Type-only imports are exempt.

**Step 5. DOM bridges.** `hero-dom-bridge`, `rewind-dom`, `host-chrome`,
`preset-seat-mark`, `details-resize` read the Host's DOM. Grep every
`data-*` attribute and every `[class*="localName"]` they use in the bundles.
CSS-module hashes change every release; local names rarely do, but check.

**Step 6. Host side.** `grep -rhoE "\b(ctx|webCtx)\.[a-zA-Z]+(\.[a-zA-Z]+)?\(" src/*.ts | sort -u`
and `grep -rhoE "ctx\.on\('[^']+'" src/*.ts`; confirm each method and event
name in `$H/dsh-*/lib/index.js`. The host-side plugin fails loudly
(`dsh-claude: ... refresh failed`), so the log usually already names these.

**Step 7. Fix in TDD order.** Change the test fakes to the new Host shape first
and watch the suite go red for the same reason the Host log does; only then
touch `src/`. A fake that still exposes the old shape is how green tests
escort a breakage through.

**Step 8. Read every plugin warning literally.** `preserving user-modified
preset` meant the installer's legacy detection had failed on a Windows path,
not that the user had edited anything. `resolves from multiple active Loader
sources` was the consequence, not a separate problem.

**Step 9. Rebuild, quit Desktop completely, start it, read the log of the new
run only**, then exercise the features by hand: a turn, the composer buttons
with a draft, rewind, the diff and plan panels. Absence of log lines is not
evidence for the client side.

Driving this over CDP (section 3) works and is how 2.0.7 was verified, with
two traps. A session opened from the sidebar takes several seconds to become
plugin-owned (lane settle plus the repository probe), so a probe that reads
the DOM after two seconds reports a missing diff button and no rewind seats
that are simply late. And while the window is hidden behind the terminal,
`document.visibilityState` is `hidden` and `requestAnimationFrame` never
fires, so anything the plugin schedules on a frame (the preset seat mark) stays
pending until the user looks at the window -- mark it manually in the probe
to check the CSS, do not report it as broken.

## 7. Desktop 2.0.7 moved two things the steps above rely on

- **The Host packages are inside `app.asar` now.** `resources/app.asar.unpacked/`
  holds native addons only. Extract before reading:

  ```bash
  npx --yes @electron/asar extract "E:/DSH Desktop/resources/app.asar" "$SCRATCH/asar"
  # Host packages: $SCRATCH/asar/node_modules/@deepseek-ai/
  ```

- **The Host runs in an Electron utility process and logs to `logs/host/`.**
  `$APPDATA/DSH Desktop/logs/dsh-<date>.log` now carries only the Electron
  shell; every `dsh-claude:` line is in
  `$APPDATA/DSH Desktop/logs/host/dsh-<date>.log`.

- **Previous package versions are on npm**, so the old side of a diff no
  longer has to come from `node_modules` before the bump:

  ```bash
  npm pack @deepseek-ai/dsh-session@0.1.2-rc.1 && tar -xzf deepseek-ai-dsh-session-0.1.2-rc.1.tgz
  ```

- **The 0.1.5 client packages import packages they do not declare** (`clsx`,
  `anser`, `katex`, `shiki`, the `micromark-*` / `mdast-util-*` family, `zod`,
  `mime-types`, and a few `@deepseek-ai/dsh-*` utilities). The Host bundles
  them itself, so runtime is unaffected, but every client test file fails to
  load until they are devDependencies. Find the set with a resolve loop over
  each package's `lib/*.js` imports rather than one at a time.

## Appendix: the Desktop 2.0.7 breakages (Host 0.1.5-rc.1)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every spawn failed: `subprocess-local: Windows Job runner exited with exit code 0 before proving its managed range empty` (catalog refresh, turns, git status, everything) | The Host runs in `utilityProcess.fork` with no `ELECTRON_RUN_AS_NODE`; on Windows `subprocess-local` now launches each ordinary target through a helper spawned as `[process.execPath, runner.js]`, which in Electron is `DSH Desktop.exe` -- it started as a second GUI instance, deferred to the running one, and exited 0 with no IPC result. Reproduced outside the plugin with a 20-line script | `src/windows-job-runner.ts` wraps `ctx.subprocess`: sets the flag in `process.env` for exactly the synchronous `spawn()` call and tells the Host to drop it from the target's own environment. All plugin subprocess users go through the one wrapped runtime |
| `SubprocessHandle.pid` gone | Handles are runner-owned; the pid is not exposed | Dropped from the supervisor snapshot |
| Hero draft transfer would not compile | `InputState.imageIds` / `addImages` / `removeImage` became `attachmentIds` / `addAttachments` / `removeAttachment` (attachments now include files) | Renamed |
| A stray ellipsis button in the Claude session header | `dsh-session-log-export` replaced its `sessionLogButton` capsule with a `moreButton` menu | Hide both local names |
| Diff, plan, tasks, and overview panels never appeared; the header toggles did nothing | The `details` column slot is gone. Its replacement is a tabbed right sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`): a panel is a tab *type* declared in `ctx.sidebarRightTabs`, its body registered into `sidebar.right.pane.tab` under the type id, opened per session through `ctx.sidebarRight.openTabIn`. Missed by the slot audit because these four registrations used `slots.register({ name: 'details' })` directly rather than `slots.inject` -- audit both spellings | `src/client/sidebar-tabs.tsx`; the plugin's maximize overlays and details-column resize are gone, the Host's own fullscreen and close take over |

Also: the Host bug is the Host's to fix; when a Desktop release sets the flag itself (or stops re-spawning `process.execPath`) the wrapper becomes a no-op because it only acts when the flag is absent.

## Appendix: the Desktop 2.0 breakages, as worked examples

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing rendered at all | `dsh.client.inject` missed the packages owning `slots` and the chat Slots | Added `dsh-client-ui-renderer` + `dsh-client-ui-chat` |
| "Rewind to here" gone | One Session snapshot split in two: `binding.session` kept `running`, chat nodes moved to `uiConversation.binding(id).target('chat')` | Compose both sources |
| Output vanished mid-render | `MarkdownText` replaced optional `codeLabels` with mandatory `labels`, no default; the code-block branch reads `labels.code.copyLabel` | Pass localized labels |
| Status bar ignored the resize divider | `--dsh-conversation-composer-max-width` removed; styles froze on the fallback | Read `--dsh-composer-card-max-width` |
| Overview panel crashed | `sessions` / `workspaces` became class instances; detached `getSnapshot` lost `this` | Bind through closures |

## Appendix: the Desktop 2.0.5 breakages (Host 0.1.2-rc.1)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every Claude session failed before the CLI started: `command catalog refresh failed … Cannot read properties of undefined (reading 'filter')` | `Session.events` getter removed; the log is now read through `snapshotEvents(from?, to?)`, `ownEvents()`, `eventAt(seq)`. Six host-side reads got `undefined`, the first one in `importLegacy` on the spawn path | `agent.session.snapshotEvents()` everywhere; test fakes expose the method, not the property |
| Installer logged `preserving user-modified preset` on every start and the client-module registry rejected the package for resolving from two Loader sources | An older installer had written the route as an absolute Windows path; the legacy check looked for `lib/preset-route.mjs` with forward slashes and never matched the backslashes | Normalize separators before the suffix check |
| "Save prompt" and "Refine prompt" icons stayed disabled with a draft on screen | The composer now renders `conversation.input.left` with empty owner props (`renderSlot(key, {})` instead of `zone`), so `input.draft` was always undefined | Read the draft through the standard `useInput` hook the runner hands every session-scoped entry |

Also in that Host: `SessionHeader.seedLength` is gone (`isSeeded` plus `Session.inheritedEventCount`, and a header still carrying `seedLength` is rejected), `seq` values are branded `SessionSeq` numbers validated as non-negative safe integers, `dsh-user-approval` no longer exports `effectiveApprovalPolicy`, and `MessageSourceMap` lost `coordinator` / `subagent-report` for `agent-message`. The devDependencies now pin `0.1.2-rc.1`, which is published, so `tsc` sees the new `Session` signature; `dsh-client-runtime` stays on `0.1.1-rc.2` because rc.1 was never published for it.
