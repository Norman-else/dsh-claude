# Implement dsh-claude-code - Intent

## TaskIntentDraft

- Requested outcome: Build and locally verify the approved DSH Claude Code CLI main-session plugin
- Goal: Build and locally verify the approved DSH Claude Code CLI main-session plugin
- Success evidence:
- Automated checks and linked-profile smoke prove native coexistence, Claude streaming, approval, cancellation, resume, and no orphan process
- Stop condition: Stop on unavailable public seam, unsafe credential forwarding, protocol incompatibility, or failed verification requiring redesign
- Non-goals:
- Cross-platform verification, DSH-managed Claude auth, attachments, npm publish
- Scope: New out-of-tree DSH bundle, preset, Host runtime, Client UI, tests, docs, and local link install
- Change kinds:
- feature, architecture, durable events, permissions, client extension
- Risk hints:
- high: external agent protocol, long-lived processes, permissions, durable session mapping

## BaselineReadSetHint

- docs/aegis/spec/2026-08-15-dsh-claude-code-spec.md

## BaselineUsageDraft

- Required baseline refs:
- docs/aegis/spec/2026-08-15-dsh-claude-code-spec.md
- Acknowledged before plan:
- none
- Cited in plan:
- none
- Missing refs:
- docs/aegis/spec/2026-08-15-dsh-claude-code-spec.md
- Advisory decision: needs-baseline-readback

## ImpactStatementDraft

- Compatibility boundary: DSH 0.1.0-rc.5 public APIs only; no core edits
- Affected layers:
- Host adapter, subprocess, approval, session events, Agent Preset, Web client
- Owners:
- dsh-claude-code plugin
- Invariants:
- Claude owns internal tools; DSH owns UI/audit/process lifecycle; native presets remain unchanged
- Non-goals:
- Cross-platform verification, DSH-managed Claude auth, attachments, npm publish

These records are Method Pack drafts / hints, not authoritative runtime decisions.
