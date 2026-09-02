/** The Claude Code model lineup, read from the running CLI instead of pinned
 *  here.
 *
 *  Anthropic ships models between releases of this plugin -- Fable arrived in a
 *  CLI update, not in one of ours -- so a table maintained here is stale the day
 *  it is written, and a model the user can already pick in `/model` is missing
 *  from the DSH selector until someone edits an array. The CLI answers the same
 *  question itself: every session's initialize response carries the lineup it
 *  would show in `/model`, already narrowed to the logged-in account's plan and
 *  to any `availableModels` restriction the settings cascade imposes.
 */
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'

/** One selectable model, in the shape the adapter advertises to DSH. */
export interface ClaudeModelRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly contextWindow?: number
}

/** What the selector shows before any session has initialized in this Host
 *  process -- a fresh app launch lands here. `default` is the only id that is
 *  valid on every release and plan; the aliases after it are the stable
 *  `/model` spellings Claude Code has kept across releases, so the menu is
 *  usable at first paint instead of a single row. The first initialize
 *  response replaces the whole list with the CLI's own lineup. */
const SEED: readonly ClaudeModelRow[] = [
  { id: 'default', name: 'Default (recommended)', description: '' },
  { id: 'opus[1m]', name: 'Opus (1M context)', description: '', contextWindow: 1_000_000 },
  { id: 'fable', name: 'Fable', description: '' },
  { id: 'sonnet', name: 'Sonnet', description: '' },
  { id: 'haiku', name: 'Haiku', description: '' },
]

/** A 1M-context route spells it in the id (`opus[1m]`, `claude-fable-5[1m]`),
 *  so this needs no capacity table either. It is only a floor: the supervisor
 *  overrides it with the window the CLI reports once a turn has run. */
function declaredContextWindow(row: ModelInfo): number | undefined {
  return /\[1m\]$/u.test(row.resolvedModel ?? row.value) ? 1_000_000 : undefined
}

function projectModel(row: ModelInfo): ClaudeModelRow {
  const contextWindow = declaredContextWindow(row)
  return {
    id: row.value,
    name: row.displayName,
    description: row.description,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

// ponytail: a module-level latest-value cache, mirroring plan usage. The plugin
// runs one supervisor per Host process and the lineup is account-wide, so
// per-session state would buy nothing.
let latest: readonly ClaudeModelRow[] | undefined

/**
 * Learn the lineup from one session's initialize response.
 * @param models - the CLI's own `/model` rows; an empty list is ignored so a
 *   CLI that answers without a catalog cannot blank the selector.
 */
export function recordClaudeModels(models: readonly ModelInfo[]): void {
  if (models.length === 0) return
  latest = models.map(projectModel)
}

/** The lineup to advertise: whatever the CLI last reported, else the seed. */
export function latestClaudeModels(): readonly ClaudeModelRow[] {
  return latest ?? SEED
}

/**
 * Look one id up in the current lineup.
 * @param id - the id DSH persisted on the session, which may name a model the
 *   running CLI no longer lists.
 * @returns the row, or undefined when the lineup does not cover the id.
 */
export function claudeModelRow(id: string): ClaudeModelRow | undefined {
  return latestClaudeModels().find(row => row.id === id)
}

/** Test seam: drop the learned lineup. */
export function resetClaudeModels(): void {
  latest = undefined
}
