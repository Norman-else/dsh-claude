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

## Appendix: the Desktop 2.0 breakages, as worked examples

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing rendered at all | `dsh.client.inject` missed the packages owning `slots` and the chat Slots | Added `dsh-client-ui-renderer` + `dsh-client-ui-chat` |
| "Rewind to here" gone | One Session snapshot split in two: `binding.session` kept `running`, chat nodes moved to `uiConversation.binding(id).target('chat')` | Compose both sources |
| Output vanished mid-render | `MarkdownText` replaced optional `codeLabels` with mandatory `labels`, no default; the code-block branch reads `labels.code.copyLabel` | Pass localized labels |
| Status bar ignored the resize divider | `--dsh-conversation-composer-max-width` removed; styles froze on the fallback | Read `--dsh-composer-card-max-width` |
| Overview panel crashed | `sessions` / `workspaces` became class instances; detached `getSnapshot` lost `this` | Bind through closures |
