# Repository Instructions

- Read `docs/aegis/spec/2026-08-15-dsh-claude-spec.md` and the current implementation plan before changing runtime behavior.
- Keep this package out-of-tree: use only public DSH exports and do not patch the installed DSH checkout.
- After a DSH Desktop upgrade, follow `docs/upgrading-dsh-desktop.md`. The Host ships no type declarations, so `pnpm typecheck` cannot see its API drift: read the installed Host under `resources/app.asar.unpacked/node_modules/@deepseek-ai/` and check the log for `dsh-claude client [boot-check]` / `[slot-entry-crashed]`.
- Claude Code owns its internal loop and tools; DSH owns presentation, approval audit, and managed process lifetime.
- Never log, persist, render, or test with real credentials. Redact before durable event append.
- Run `PATH=/opt/homebrew/bin:$PATH pnpm check` before claiming completion.
