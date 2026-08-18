# dsh-claude-code verification evidence

Date: 2026-08-15

## Static and fixture verification

- `pnpm typecheck`: passed for Host and Client TypeScript projects.
- `pnpm test`: 10 files, 62 tests passed.
- `pnpm build`: Host, preset route, CLI, and browser artifacts emitted under `lib/` without errors.
- `pnpm pack --pack-destination ./dist-pack`: produced `dist-pack/dsh-claude-code-0.1.0.tgz` with the declared Host/Client/CLI/preset artifacts.

Covered boundaries include event vocabulary and bounds, recursive/key and inline-string credential redaction, executable resolution and safe Doctor parsing, exact SDK executable enforcement, sensitive/DSH environment scrubbing, process exit/tree termination mapping, approval allow-once/fail-closed mapping, SDK message normalization, stream chunk ordering, no outer DSH tool calls, per-session query reuse, cancellation before and after submission, outcome-unknown crash classification, LRU process eviction, concurrent no-clobber preset installation, client event projection/rendering, preset route scoping, and Doctor privacy/authorization.

## Independent review integration

- Security/lifecycle review: `security-lifecycle-review.md` — 2 Critical, 12 Important, 2 Minor findings integrated.
- Runtime correctness review: `runtime-correctness-review.md` — 2 Critical, 18 Important, 6 Minor findings integrated.

All release-blocking findings were resolved: client bundle format, durable credential persistence, cancellation queued-message lifecycle, concurrent-entry race, append-failure containment, initialization/Doctor deadlines, malformed/unknown SDK handling, rc.5 event-vocabulary contract, Doctor privacy, multi-step projection identity, transactional/versioned preset behavior, teardown awaiting, model configuration, and durable usage schema.

## Local runtime probes

- CLI Doctor resolved the local `claude` executable, parsed version `2.1.233`, and reported only coarse signed-in/auth category fields.
- A minimal Agent SDK query with the explicit local executable completed protocol initialization and returned the exact requested fixed text with usage; tools were disabled and the run was limited to one turn.
- No credentials, email, organization identifiers, or raw auth payloads were printed by either probe.

## DSH profile integration

- Official DSH plugin command linked `dsh-claude-code` into the existing `web` profile successfully.
- `dsh --profile web --dump-config` composed an `llm-claude-code-cli` row with `name: dsh-claude-code`.
- `node lib/bin.mjs install-preset` installed `$DSH_HOME/.agent-presets/claude-code-cli/{agent.cordis.yml,preset.yml}`; both files match the package-managed sources.
- The current Host process at `http://127.0.0.1:56454` started before the profile link, so its Doctor route remains 404 until that Host is restarted. No replacement Web server was started.

## Remaining live checks

After restarting the existing DSH Host:

1. Doctor endpoint and Settings page load.
2. Claude Code CLI preset appears alongside native presets.
3. One DSH-owned Claude turn streams and records activity.
4. Permission reject/allow-once, cancel, reload/resume, and process cleanup are exercised through the real UI.
