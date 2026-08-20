# Agent Installation Runbook

This runbook is idempotent for a local `dsh-claude` checkout and an existing DSH `web` profile.

## 1. Verify the checkout

```sh
cd /path/to/dsh-claude
export PATH="/opt/homebrew/bin:$PATH"
pnpm install
pnpm check
node lib/bin.mjs doctor
```

Stop if Doctor cannot find an authenticated local Claude Code installation. Do not request, copy, or write credentials.

## 2. Link the bundle into the current Web profile

The bundle registers its package-contained Claude preset as a system preset; no files are copied into the user preset root.

```sh
dsh plugin --profile web add "link:$(pwd)"
```

Do not start another DSH Web server. This bundle must load in the existing app at `http://127.0.0.1:56454`.

## 3. Refresh and smoke test

1. Refresh the existing DSH Web page.
2. Confirm **Claude** appears in the new-session Agent Preset picker.
3. Run one existing native preset prompt and verify it remains native.
4. Create a Claude session and send a read-only prompt.
5. Send one edit prompt; verify DSH displays a permission request. Exercise reject first, then allow once with a harmless temporary file.
6. Cancel a running prompt and confirm the cancelled session owns no child `claude` process that is still executing cancelled work or left orphaned/unowned.
7. Refresh the browser and continue the session.
8. Restart DSH and confirm the next prompt resumes the persisted Claude session.

A live prompt can consume the user's Claude subscription. Keep it minimal.

## 4. Uninstall

```sh
dsh plugin --profile web remove @norman-else/dsh-claude
```

The package-contained system preset disappears with the dependency. No source checkout or separate cleanup command is required.
