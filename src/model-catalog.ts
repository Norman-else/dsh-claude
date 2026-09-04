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
 *
 *  What DSH persists on a session, though, must NOT be a CLI model id. DSH
 *  stores the selector row's id verbatim and matches it back by string
 *  equality, so a concrete id (`claude-fable-5-1[1m]`) turns into a dangling
 *  reference the moment Anthropic bumps the version -- the session keeps
 *  pointing at a row nothing advertises any more, and the composer falls back
 *  to printing the raw id. The selector therefore advertises an alias this
 *  plugin owns (`fable[1m]`), derived from the row rather than tabulated, and
 *  the CLI id it stands for is kept beside it and used only at dispatch.
 */
import {
  query as claudeQuery,
  type ModelInfo,
  type Options as ClaudeOptions,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

/** One selectable model, in the shape the adapter advertises to DSH. */
export interface ClaudeModelRow {
  /** Stable selector id, persisted by DSH on the session. An alias this plugin
   *  owns -- never a CLI model id, which changes under it. */
  readonly id: string
  /** The spelling the CLI is actually given for this row. */
  readonly value: string
  readonly name: string
  readonly description: string
  readonly contextWindow?: number
}

/** A 1M-context route spells it in the id (`opus[1m]`, `claude-fable-5-1[1m]`). */
const WIDE_ROUTE = /\[1m\]$/u

/** What the selector shows before the lineup is known -- the probe below failed
 *  or has not answered yet. `default` is the only id that is valid on every
 *  release and plan; the rest are the stable `/model` spellings Claude Code has
 *  kept across releases, and every one of them is a spelling the CLI accepts,
 *  so a session that persists one still dispatches. */
const SEED: readonly ClaudeModelRow[] = [
  { id: 'default', value: 'default', name: 'Default (recommended)', description: '' },
  { id: 'opus[1m]', value: 'opus[1m]', name: 'Opus (1M context)', description: '', contextWindow: 1_000_000 },
  { id: 'fable', value: 'fable', name: 'Fable', description: '' },
  { id: 'sonnet', value: 'sonnet', name: 'Sonnet', description: '' },
  { id: 'haiku', value: 'haiku', name: 'Haiku', description: '' },
]

/** A 1M-context route spells it in the id, so this needs no capacity table
 *  either. It is only a floor: the supervisor overrides it with the window the
 *  CLI reports once a turn has run. */
function declaredContextWindow(row: ModelInfo): number | undefined {
  return WIDE_ROUTE.test(row.resolvedModel ?? row.value) ? 1_000_000 : undefined
}

/**
 * The selector id for one CLI row: the model's family, plus the `[1m]` marker
 * when the route carries one.
 *
 * Derived, never tabulated -- a family this plugin has never heard of gets its
 * id the same way, so a model Anthropic ships tomorrow lands in the selector
 * without an edit here, and a version bump (`claude-fable-5-1` ->
 * `claude-fable-5-2`) leaves an already-persisted selection pointing at the
 * same row. The family is the first non-numeric segment, which covers both
 * spellings Anthropic has used (`claude-fable-5-1`, `claude-3-5-sonnet-…`).
 *
 * Read off `value` alone, never the id it resolves to: `default` names a route
 * whose resolution moves with the account and the release, so folding the
 * resolved `[1m]` in would flip an already-persisted `default` to `default[1m]`
 * the day Anthropic repoints it.
 * @param value - the CLI's own id for the row.
 * @returns the alias to advertise.
 */
export function claudeModelAlias(value: string): string {
  const wide = WIDE_ROUTE.test(value)
  const bare = value.replace(WIDE_ROUTE, '').replace(/^claude-/u, '')
  const family = bare.split('-').find(segment => !/^\d+$/u.test(segment)) ?? bare
  return wide ? `${family}[1m]` : family
}

function projectModel(row: ModelInfo, id: string): ClaudeModelRow {
  const contextWindow = declaredContextWindow(row)
  return {
    id,
    value: row.value,
    name: row.displayName,
    description: row.description,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

// ponytail: a module-level latest-value cache, mirroring plan usage. The plugin
// runs one supervisor per Host process and the lineup is account-wide, so
// per-session state would buy nothing.
let latest: readonly ClaudeModelRow[] | undefined
let inflight: Promise<readonly ClaudeModelRow[]> | undefined

/**
 * Learn the lineup from one session's initialize response.
 * @param models - the CLI's own `/model` rows; an empty list is ignored so a
 *   CLI that answers without a catalog cannot blank the selector.
 */
export function recordClaudeModels(models: readonly ModelInfo[]): void {
  if (models.length === 0) return
  const taken = new Set<string>()
  latest = models.map(row => {
    const alias = claudeModelAlias(row.value)
    // Two rows of one family in the same lineup (a previous generation kept
    // alongside the current one) cannot share an id; the later row keeps the
    // CLI's own spelling rather than silently shadowing the first.
    const id = taken.has(alias) ? row.value : alias
    taken.add(id)
    return projectModel(row, id)
  })
}

/** The lineup to advertise: whatever the CLI last reported, else the seed. */
export function latestClaudeModels(): readonly ClaudeModelRow[] {
  return latest ?? SEED
}

/** A throwaway probe should not outlive a wedged CLI. */
export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 20_000

/**
 * Read the lineup from a throwaway CLI process.
 *
 * Waiting for a session to start is too late: DSH loads the model catalog once
 * per Host generation, at connect, and does not reload it when this plugin
 * later learns the real lineup. A selector left on the seed until then hands
 * out seed ids, which is exactly how a session ends up persisting an id the
 * next launch cannot resolve. This query carries no tools, no permission
 * bridge and no session binding: it starts, reports what `/model` would show,
 * and is killed -- no prompt is ever sent, so it costs no tokens.
 * @param executablePath - the resolved CLI, or '' to let the SDK find it.
 * @param factory - test seam for the SDK query.
 * @returns the CLI's own `/model` rows.
 */
export async function probeClaudeModels(
  executablePath: string,
  factory: (params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeOptions }) => Query = claudeQuery,
): Promise<readonly ModelInfo[]> {
  const lifetime = new AbortController()
  const timer = setTimeout(() => lifetime.abort(), CLAUDE_MODEL_PROBE_TIMEOUT_MS)
  timer.unref?.()
  // The SDK ends a query as soon as its prompt stream closes, so hold the
  // stream open and let the abort below tear the process down instead.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<never>(() => {})
  })()
  const query = factory({
    prompt,
    options: {
      cwd: process.cwd(),
      abortController: lifetime,
      ...(executablePath.length === 0 ? {} : { pathToClaudeCodeExecutable: executablePath }),
    },
  })
  try {
    void (async () => { for await (const _ of query) { /* drain */ } })().catch(() => undefined)
    // Aborting tears the probe process down, but the SDK's pending
    // initialization is not documented to settle with it, and an unsettled one
    // would hang the catalog load (and the browser connection serving it) for
    // the life of the Host. The deadline is therefore enforced here too.
    const initialization = await Promise.race([
      query.initializationResult(),
      new Promise<never>((_resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('dsh-claude: the model lineup probe did not answer in time')),
          CLAUDE_MODEL_PROBE_TIMEOUT_MS,
        )
        deadline.unref?.()
      }),
    ])
    return initialization.models
  } finally {
    clearTimeout(timer)
    lifetime.abort()
  }
}

/**
 * The lineup, learning it from the CLI the first time DSH asks for the catalog.
 * @param probe - reads the CLI's rows; a failure leaves the seed in place and
 *   is retried on the next catalog load.
 * @returns the rows to advertise, never rejecting.
 */
export function ensureClaudeModels(probe: () => Promise<readonly ModelInfo[]>): Promise<readonly ClaudeModelRow[]> {
  if (latest !== undefined) return Promise.resolve(latest)
  inflight ??= probe()
    .then(models => { recordClaudeModels(models) })
    .catch(() => undefined)
    .then(() => {
      inflight = undefined
      return latestClaudeModels()
    })
  return inflight
}

/**
 * Look one id up in the current lineup.
 * @param id - the id DSH persisted on the session, which may be an alias, a
 *   concrete CLI id persisted before this plugin aliased anything, or a row the
 *   running CLI no longer lists.
 * @returns the row, or undefined when the lineup does not cover the id.
 */
export function claudeModelRow(id: string): ClaudeModelRow | undefined {
  const rows = latestClaudeModels()
  return rows.find(row => row.id === id)
    ?? rows.find(row => row.value === id)
    ?? rows.find(row => row.id === claudeModelAlias(id))
}

/**
 * The spelling to hand the CLI for one selector id.
 * @param id - the id DSH persisted on the session.
 * @returns the CLI's own id, or the selector id itself when the lineup does not
 *   cover it -- the seed vocabulary is made of spellings the CLI accepts, and a
 *   session persisted before this plugin aliased anything already holds one.
 */
export function claudeModelValue(id: string): string {
  return claudeModelRow(id)?.value ?? id
}

/** Test seam: drop the learned lineup. */
export function resetClaudeModels(): void {
  latest = undefined
  inflight = undefined
}
