import { useEffect, useMemo, useRef, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { FALLBACK_CONTEXT_COLOR, type ClaudeActivityEvent, type ClaudeContextUsageCategory, type ClaudeContextUsageEvent } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'

/** Ring geometry, matching the Host's own meter: 14px viewBox, 2px stroke. */
const RING_RADIUS = 5.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
/** The CLI's own name for the unused window; it is not part of what is used. */
const FREE_SPACE = 'Free space'
const MAX_ROWS = 12
/** Breakdown rows worth naming; the rest of the CLI's accounting stays out. */
const MAX_BREAKDOWN_ROWS = 6

/** The CLI's category names, in this plugin's two locales. A row the CLI adds
 *  later falls back to its own name rather than disappearing. */
const CATEGORY_LABELS: Readonly<Record<string, ClaudeCodeSettingsKey>> = {
  'System prompt': 'contextCategorySystemPrompt',
  'System tools': 'contextCategorySystemTools',
  'MCP tools': 'contextCategoryMcpTools',
  'Memory files': 'contextCategoryMemory',
  Messages: 'contextCategoryMessages',
  Skills: 'contextCategorySkills',
  Agents: 'contextCategoryAgents',
  'Free space': 'contextCategoryFree',
}

/** The color each category this panel draws is separated by.
 *
 *  Claude Code's report carries no color of its own: every category arrives
 *  wearing the same "no color reported" value, so a legend drawn straight from
 *  it names rows it cannot tell apart. The three categories the Host's own
 *  meter also draws keep the Host's hues — neutral for the system prompt,
 *  violet for tools, blue for messages — so a reader moving between the two
 *  meters reads the same color for the same thing; the rest of the CLI's
 *  accounting gets a hue of its own. */
const CATEGORY_COLORS: Readonly<Record<string, string>> = {
  'System prompt': 'var(--dsw-static-neutral-bluish-400, #8b95a5)',
  'System tools': '#a78bfa',
  'MCP tools': '#34d399',
  'Memory files': '#fbbf24',
  Messages: 'var(--dsw-static-blue-450, #3b82f6)',
  Skills: '#f472b6',
  Agents: '#22d3ee',
}

/** Hues for a category this panel has not been taught: the CLI may add one at
 *  any time, and hashing its name keeps a row on the same hue across renders
 *  and between sessions. */
const CATEGORY_PALETTE: readonly string[] = Object.values(CATEGORY_COLORS)

/** The color one category is drawn with: the one the CLI chose when it chose
 *  one, and otherwise a hue that separates this category from the rows beside
 *  it. */
export function contextCategoryColor(category: ClaudeContextUsageCategory): string {
  if (category.color.toLowerCase() !== FALLBACK_CONTEXT_COLOR) return category.color
  const known = CATEGORY_COLORS[category.name]
  if (known !== undefined) return known
  let hash = 0
  for (const character of category.name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0
  return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length] as string
}

export interface ClaudeContextMeterInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

export interface ClaudeContextMeterProps extends ClaudeContextMeterInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

/** A token count the way this panel reads one: no more precision than the
 *  number deserves, and no locale-dependent grouping in a 264px column. */
export function formatContextTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`
  return `${Math.round(value / 100_000) / 10}M`
}

/** The rows the panel draws: what is used, biggest first, with the CLI's own
 *  colors. Free space is the absence of usage, so it is not a row. */
export function usedContextRows(usage: ClaudeContextUsageEvent): readonly ClaudeContextUsageEvent['categories'][number][] {
  return usage.categories
    .filter(category => category.tokens > 0 && category.name !== FREE_SPACE)
    .slice()
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, MAX_ROWS)
}

/** The newest compaction the transcript recorded, which is the only place the
 *  before/after figures exist: the CLI reports them once, at the boundary. */
export function latestCompaction(activities: readonly ClaudeActivityEvent[]): ClaudeActivityEvent | undefined {
  let found: ClaudeActivityEvent | undefined
  for (const activity of activities) if (activity.kind === 'compaction') found = activity
  return found
}

function compactionFigures(activity: ClaudeActivityEvent): {
  pre?: number | undefined
  post?: number | undefined
  durationMs?: number | undefined
  trigger?: string | undefined
} {
  let detail: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(activity.detail ?? '{}')
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>
  } catch {
    // A detail that is not JSON tells nothing about the figures.
  }
  const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const pre = number(detail.preTokens)
  const post = number(detail.postTokens)
  const durationMs = number(detail.durationMs)
  const trigger = detail.trigger === 'auto' || detail.trigger === 'manual' ? detail.trigger : undefined
  return {
    ...(pre === undefined ? {} : { pre }),
    ...(post === undefined ? {} : { post }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(trigger === undefined ? {} : { trigger }),
  }
}

/** The composer's context meter for a Claude session.
 *
 *  The Host draws its own meter from what DSH can see of the request, and for
 *  this preset that is not the context: the conversation lives in Claude Code,
 *  the tools are the CLI's own, and the only honest figures come from the CLI's
 *  context report. So this session gets this meter instead — the same ring in
 *  the same seat, opened onto Claude's own composition: every category it
 *  accounts for, what the messages are made of, and whether (and when) it
 *  compacts on its own. It renders nothing for any other session, which keeps
 *  the Host's meter exactly as it was for everything else. */
export function ClaudeContextMeter({ useClaudeProjection, t }: ClaudeContextMeterProps) {
  const usage = useClaudeProjection(value => value.contextUsage)
  const owned = useClaudeProjection(value => value.owned)
  const compaction = useClaudeProjection(value => latestCompaction(value.activities))
  // Whether this session has run at all, which is what a fresh conversation has
  // not done yet. The usage sample alone cannot say so: `importLegacy` seeds
  // `contextUsage` from a resumed session's own event log, so a session that has
  // sent nothing already holds a figure and would open wearing it. The activity
  // list is the honest signal — empty means nothing has run here, while any
  // conversation with history carries one, so its own usage still shows at once.
  const started = useClaudeProjection(value => value.activities.length > 0)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const available = owned && started && usage !== undefined

  // The Host's meter reads the same window and draws the same ring from a
  // composition it cannot see for this preset; for as long as this one is
  // mounted, that one stands down.
  useEffect(() => {
    if (!available) return undefined
    document.body.dataset.dshClaudeContextMeter = ''
    return () => { delete document.body.dataset.dshClaudeContextMeter }
  }, [available])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const percent = Math.min(100, Math.max(0, Math.round(usage?.percentage ?? 0)))

  if (!available || usage === undefined) return null

  return (
    <span ref={rootRef} style={styles.contextMeterRoot} data-dsh-claude-context-meter="">
      <button
        type="button"
        data-dsh-claude-context-trigger=""
        style={open ? { ...styles.contextMeterTrigger, ...styles.contextMeterTriggerOpen } : styles.contextMeterTrigger}
        aria-label={t('contextAria', { percent: `${percent}%` })}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
          <circle cx={7} cy={7} r={RING_RADIUS} fill="none" strokeWidth={2} style={styles.contextMeterTrack} />
          <circle
            cx={7}
            cy={7}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
            transform="rotate(-90 7 7)"
            style={styles.contextMeterFill}
          />
        </svg>
      </button>
      {open ? <ClaudeContextPanel usage={usage} {...(compaction === undefined ? {} : { compaction })} t={t} /> : null}
      {/* `available` above is what leaves this component empty for any other
          session, which in turn leaves the Host's own meter in place. */}
    </span>
  )
}

/** The opened panel: what the context is made of, from the CLI's own report.
 *
 *  `compaction` is the newest boundary the transcript recorded, which is the
 *  only place a compaction's before/after figures exist. */
export function ClaudeContextPanel({ usage, compaction, t }: {
  usage: ClaudeContextUsageEvent
  compaction?: ClaudeActivityEvent
  t: ClaudeContextMeterInjected['t']
}) {
  const percent = Math.min(100, Math.max(0, Math.round(usage.percentage)))
  const rows = usedContextRows(usage)
  const used = rows.reduce((sum, row) => sum + row.tokens, 0)
  const breakdown = usage.messageBreakdown
  const breakdownRows: readonly (readonly [ClaudeCodeSettingsKey, number])[] = breakdown === undefined ? [] : ([
    ['contextBreakdownToolResults', breakdown.toolResultTokens],
    ['contextBreakdownToolCalls', breakdown.toolCallTokens],
    ['contextBreakdownAttachments', breakdown.attachmentTokens],
    ['contextBreakdownAssistant', breakdown.assistantMessageTokens],
    ['contextBreakdownUser', breakdown.userMessageTokens],
    ['contextBreakdownRedirected', breakdown.redirectedContextTokens],
  ] satisfies (readonly [ClaudeCodeSettingsKey, number])[])
    .filter(([, tokens]) => tokens > 0)
    .slice(0, MAX_BREAKDOWN_ROWS)
  const figures = compaction === undefined ? undefined : compactionFigures(compaction)
  return (
    <div style={styles.contextMeterPanel} data-dsh-claude-context-panel="" role="dialog" aria-label={t('contextUsed')}>
      <div style={styles.contextMeterHeader}>
        <span style={styles.contextMeterHeadline}>{t('contextUsed')}</span>
        <span style={styles.contextMeterPercent}>{percent}%</span>
        <span style={styles.contextMeterFigures}>{`~${formatContextTokens(usage.totalTokens)} / ${formatContextTokens(usage.maxTokens)}`}</span>
      </div>
      {percent < 100 ? null : <div style={styles.contextMeterWarning}>{t('contextOverLimit')}</div>}
      <div style={styles.contextMeterBar}>
        {rows.length === 0
          // A report whose categories are all empty still has a used figure to
          // draw, and no category to tint it with.
          ? <span style={{ ...styles.contextMeterSegment, background: 'var(--dsw-alias-label-tertiary)', width: '100%' }} />
          : rows.map(row => (
            <span
              key={row.name}
              style={{
                ...styles.contextMeterSegment,
                background: contextCategoryColor(row),
                width: `${Math.max(1, (percent * row.tokens) / Math.max(1, used))}%`,
              }}
            />
          ))}
      </div>
      <dl style={styles.contextMeterRows}>
        {rows.map(row => (
          <div key={row.name} style={styles.contextMeterRow}>
            <dt style={styles.contextMeterRowLabel}>
              <span style={{ ...styles.contextMeterSwatch, background: contextCategoryColor(row) }} aria-hidden="true" />
              {CATEGORY_LABELS[row.name] === undefined ? row.name : t(CATEGORY_LABELS[row.name] as ClaudeCodeSettingsKey)}
              {row.isDeferred === true ? <span style={styles.contextMeterDeferred}>{t('contextDeferred')}</span> : null}
            </dt>
            <dd style={styles.contextMeterRowValue}>{`~${formatContextTokens(row.tokens)}`}</dd>
          </div>
        ))}
      </dl>
      {breakdownRows.length === 0 ? null : (
        <>
          <div style={styles.contextMeterSection}>{t('contextBreakdownTitle')}</div>
          <dl style={styles.contextMeterRows}>
            {breakdownRows.map(([key, tokens]) => (
              <div key={key} style={styles.contextMeterRow}>
                <dt style={{ ...styles.contextMeterRowLabel, ...styles.contextMeterSecondary }}>{t(key)}</dt>
                <dd style={{ ...styles.contextMeterRowValue, ...styles.contextMeterSecondary }}>{`~${formatContextTokens(tokens)}`}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div style={styles.contextMeterFoot}>
        {/* A report that does not say must not read as "off". */}
        {usage.isAutoCompactEnabled === undefined ? null : (
          <span>
            {usage.isAutoCompactEnabled
              ? t('contextAutoCompactOn', usage.autoCompactThreshold === undefined
                  ? {}
                  : {
                      tokens: formatContextTokens(usage.autoCompactThreshold),
                      percent: usage.maxTokens === 0 ? 0 : Math.round((usage.autoCompactThreshold / usage.maxTokens) * 100),
                    })
              : t('contextAutoCompactOff')}
          </span>
        )}
        {figures === undefined ? null : (
          <span>
            {t('contextLastCompaction', {
              ...(figures.trigger === 'auto' ? { trigger: t('compactedAuto') } : figures.trigger === 'manual' ? { trigger: t('compacted') } : {}),
              ...(figures.pre === undefined ? {} : { pre: formatContextTokens(figures.pre) }),
              ...(figures.post === undefined ? {} : { post: formatContextTokens(figures.post) }),
              ...(figures.durationMs === undefined ? {} : { seconds: (figures.durationMs / 1_000).toFixed(1) }),
            })}
          </span>
        )}
        {usage.model === '' ? null : <span>{usage.model}</span>}
      </div>
    </div>
  )
}
