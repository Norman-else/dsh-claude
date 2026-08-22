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

The bundle retains its package-contained system preset and installs a protected compatibility copy at `$DSH_HOME/.agent-presets/claude` during Host activation. This works around supported DSH release-candidate builds replacing third-party preset roots. Existing user-modified files are preserved rather than overwritten.

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

Clean up the managed preset while the profile can still execute the package CLI, then remove the plugin:

```sh
dsh plugin --profile web exec dsh-claude remove-preset
dsh plugin --profile web remove @norman-else/dsh-claude
```

DSH has no plugin uninstall lifecycle hook, so direct package removal can leave the compatibility preset behind. After direct removal, no source checkout is required; run the matching package version:

```sh
pnpm dlx @norman-else/dsh-claude@<version> remove-preset
```

Cleanup refuses to delete user-modified preset content.
