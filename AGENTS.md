# Repository Instructions

- Read `docs/aegis/spec/2026-08-15-dsh-claude-code-spec.md` and the current implementation plan before changing runtime behavior.
- Keep this package out-of-tree: use only public DSH exports and do not patch the installed DSH checkout.
- Claude Code owns its internal loop and tools; DSH owns presentation, approval audit, and managed process lifetime.
- Never log, persist, render, or test with real credentials. Redact before durable event append.
- Run `PATH=/opt/homebrew/bin:$PATH pnpm check` before claiming completion.
