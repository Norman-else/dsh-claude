# Agent Installation Runbook

This runbook is idempotent for the checkout at `/Users/normanzuo/PersonalRepos/dsh-claude-code` and the existing DSH `web` profile.

## 1. Verify the checkout

```sh
cd /Users/normanzuo/PersonalRepos/dsh-claude-code
export PATH="/opt/homebrew/bin:$PATH"
pnpm install
pnpm check
node lib/bin.mjs doctor
```

Stop if Doctor cannot find an authenticated local Claude Code installation. Do not request, copy, or write credentials.

## 2. Install the managed Agent Preset

Host activation normally does this automatically. Running it explicitly is safe:

```sh
node lib/bin.mjs install-preset
```

Expected output is `installed` on first run or `unchanged` on later runs. A conflict is terminal until a human chooses what to do with the existing user preset.

## 3. Link the bundle into the current Web profile

```sh
node "/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add "link:/Users/normanzuo/PersonalRepos/dsh-claude-code"
```

Do not start another DSH Web server. This bundle must load in the existing app at `http://127.0.0.1:56454`.

## 4. Refresh and smoke test

1. Refresh the existing DSH Web page.
2. Confirm **Claude Code CLI** appears in the new-session Agent Preset picker.
3. Run one existing native preset prompt and verify it remains native.
4. Create a Claude Code CLI session and send a read-only prompt.
5. Send one edit prompt; verify DSH displays a permission request. Exercise reject first, then allow once with a harmless temporary file.
6. Cancel a running prompt and confirm no child `claude` process remains for the cancelled session.
7. Refresh the browser and continue the session.
8. Restart DSH and confirm the next prompt resumes the persisted Claude session.

A live prompt can consume the user's Claude subscription. Keep it minimal.

## 5. Uninstall safely

Run before removing the link:

```sh
cd /Users/normanzuo/PersonalRepos/dsh-claude-code
node lib/bin.mjs remove-preset
node "/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web remove dsh-claude-code
```

The remover refuses to delete any user-modified preset file.
