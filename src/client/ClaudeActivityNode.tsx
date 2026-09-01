import { useMemo, useState } from 'react'
import {
  DiffBlock,
  DisclosureRow,
  IconApiOutline14,
  IconThinkOutline14,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClaudeActivityEvent, ClaudeUsage } from '../events.ts'
import type { ClaudeActivityChatData, ClaudeCompaction, ClaudeSubcall, ClaudeTranscriptTool } from './conversation-sidecar.ts'
import { transcriptItemsForStep } from './conversation-sidecar.ts'
import { ClaudeMarkdown, useClaudeMarkdownLabels } from './markdown-labels.tsx'
import { selectStepActivities } from './projection.ts'
import { formatTokenCount } from './token-format.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'

type Translate = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string

export type ClaudeActivityNodeProps = Omit<ChatNodeViewProps<'claude-activity-step'>, 't'> & { t: Translate }

const EMPTY_TASKS = [] as const

const ACTIVITY_CSS = [
  '.dsh-claude-flow{display:flex;flex-direction:column;gap:10px}',
  '.dsh-claude-transcript-text{color:var(--dsw-alias-label-primary);font-size:15px;line-height:24px;overflow-wrap:anywhere}',
  '.dsh-claude-tool-group-native{overflow:visible}',
  '.dsh-claude-tool-group-native>.dsh-claude-flow-row{padding:0}',
  '.dsh-claude-tool-list{max-height:min(420px,calc(100vh - 320px));overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;margin-top:4px;border:1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent));border-radius:10px;scrollbar-gutter:stable}',
  '.dsh-claude-tool-item{border-top:1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent))}',
  '.dsh-claude-tool-item:first-child{border-top:0}',
  '.dsh-claude-tool-summary-row{display:flex;align-items:center;min-height:34px;gap:8px;padding:0 10px;cursor:pointer;list-style:none}',
  '.dsh-claude-tool-summary-row::-webkit-details-marker{display:none}',
  '.dsh-claude-tool-summary-row::after{content:"›";margin-left:2px;flex:none;align-self:center;color:var(--dsw-alias-label-secondary);font-size:22px;line-height:1;transform-origin:center;transition:transform .15s ease}',
  '.dsh-claude-tool-item[open]>.dsh-claude-tool-summary-row::after{transform:rotate(90deg)}',
  '.dsh-claude-tool-content{min-width:0;padding:0 10px 8px}',
  '.dsh-claude-tool-content>*{max-width:100%;box-sizing:border-box}',
  '.dsh-claude-tool-section{margin-top:8px}',
  '.dsh-claude-tool-section-title{margin-bottom:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-transform:uppercase;letter-spacing:.04em}',
  '.dsh-claude-tool-fields{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 12px;font-size:13px;line-height:20px}',
  '.dsh-claude-tool-field-key{color:var(--dsw-alias-label-tertiary)}',
  '.dsh-claude-tool-field-value{min-width:0;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-claude-tool-paths{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;font:var(--dsw-font-markdown-code-block-small)}',
  '.dsh-claude-tool-path{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-tool-code{max-height:260px;overflow:auto;margin:0;padding:8px 0;border-radius:8px;background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small)}',
  '.dsh-claude-tool-code-line{display:grid;grid-template-columns:44px minmax(max-content,1fr);min-height:18px}',
  '.dsh-claude-tool-line-number{padding-right:10px;text-align:right;user-select:none;color:var(--dsw-alias-label-caption);border-right:1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent))}',
  '.dsh-claude-tool-line-text{padding:0 10px;white-space:pre}',
  '.dsh-claude-tool-label{width:72px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-claude-tool-description{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-tool-stats{display:inline-flex;gap:4px;flex:none;font-size:13px;line-height:20px}',
  '.dsh-claude-diff-add{color:var(--dsw-alias-state-success-primary,#21c55d)}',
  '.dsh-claude-diff-delete{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-claude-tool-name{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-tool-summary{margin-left:8px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-claude-turn-usage{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:10px;',
    'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
  '.dsh-claude-turn-usage-label{color:var(--dsw-alias-label-caption)}',
  '.dsh-claude-tool-terminal{display:flex;gap:8px;margin:6px 0 0;padding:8px 10px;max-height:220px;overflow:auto;',
    'border-radius:8px;background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small)}',
  '.dsh-claude-tool-prompt{flex:none;user-select:none;color:var(--dsw-alias-label-caption)}',
  '.dsh-claude-tool-command{min-width:0;margin:0;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-claude-tool-detail{margin:6px 0 0;padding:8px 10px;max-height:220px;overflow:auto;border-radius:8px;background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-claude-flow-row{position:relative;overflow:hidden}',
  '.dsh-claude-flow-leading{flex-shrink:0}',
  '.dsh-claude-flow-title{font-weight:400}',
  '.dsh-claude-flow-chevron{color:var(--dsw-alias-label-secondary)}',
  '.dsh-claude-flow-separator{width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption);flex:none}',
  '.dsh-claude-flow-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;flex:auto}',
  '.dsh-claude-flow-summary[data-error]{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-claude-flow-body{margin:4px 0 4px 22px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-claude-flow-detail{max-height:260px;overflow:auto;margin:4px 0 4px 4px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent));border-radius:12px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap}',
  '.dsh-claude-flow-subcalls{display:flex;flex-direction:column;gap:2px;margin:4px 0 4px 22px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:22px}',
  '.dsh-claude-compaction{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
  '.dsh-claude-compaction::before,.dsh-claude-compaction::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent))}',
  '.dsh-claude-compaction-label{flex:none;white-space:nowrap}',
  '.dsh-claude-act-running{animation:dsh-claude-act-pulse 1.2s ease-in-out infinite}',
  '@keyframes dsh-claude-act-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
].join('')

let cssInjected = false
function ensureCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const element = document.createElement('style')
  element.dataset.dshClaudeActivity = ''
  element.textContent = ACTIVITY_CSS
  document.head.appendChild(element)
}

function subcallGlyph(subcall: ClaudeSubcall): string {
  if (subcall.isError === true || subcall.phase === 'failed') return '×'
  if (subcall.phase === 'started' || subcall.phase === 'updated') return '●'
  return '✓'
}

function title(activity: ClaudeActivityEvent): string {
  return activity.toolName ?? activity.title ?? activity.kind.replaceAll('-', ' ')
}

function activityState(activity: ClaudeActivityEvent, running: boolean): 'done' | 'ongoing' | 'warning' | 'error' {
  if (activity.isError === true || activity.kind === 'error' || activity.phase === 'denied' || activity.phase === 'failed') return 'error'
  if (running) return 'ongoing'
  if (activity.kind === 'warning') return 'warning'
  return 'done'
}

function ActivityRow({ row, t }: { row: ClaudeActivityChatData; t: Translate }) {
  const { activity, running, subcalls } = row
  const [open, setOpen] = useState(false)
  const state = activityState(activity, running)
  const detail = activity.detail
  const expandable = detail !== undefined || subcalls.length > 0 || activity.kind === 'thinking'
  const summary = activity.summary ?? (running ? t('running') : state === 'error' ? t('failed') : t('done'))
  const body = activity.kind === 'thinking' ? activity.summary : detail
  const icon = activity.kind === 'thinking'
    ? <IconThinkOutline14 size={14} />
    : state === 'done'
      ? <IconApiOutline14 size={14} />
      : <StateDot state={state} />
  return (
    <DisclosureRow
      rowClassName="dsh-claude-flow-row"
      leadingClassName="dsh-claude-flow-leading"
      titleClassName="dsh-claude-flow-title"
      chevronClassName="dsh-claude-flow-chevron"
      icon={icon}
      title={activity.kind === 'thinking' ? t('thinking') : title(activity)}
      open={open}
      expandable={expandable}
      expandOnRowClick
      keepContentWhenOpen
      onToggle={() => setOpen(value => !value)}
      collapsedContent={(
        <>
          <span className="dsh-claude-flow-separator" aria-hidden="true" />
          <span className="dsh-claude-flow-summary" data-error={state === 'error' || undefined}>{summary}</span>
        </>
      )}
    >
      {subcalls.length === 0 ? null : (
        <div className="dsh-claude-flow-subcalls">
          {subcalls.map(subcall => (
            <div key={subcall.toolUseId}>{subcallGlyph(subcall)} {subcall.toolName ?? t('subagent')}{subcall.summary === undefined ? '' : ` · ${subcall.summary}`}</div>
          ))}
        </div>
      )}
      {body === undefined ? null : activity.kind === 'thinking'
        ? <div className="dsh-claude-flow-body">{body}</div>
        : <pre className="dsh-claude-flow-detail">{body}</pre>}
    </DisclosureRow>
  )
}

/** Compaction has no turn of its own to render, so the transcript marks it with
 *  a rule instead of a row: it separates prose rather than reporting work. */
export function ClaudeCompactionDivider({ compaction, t }: { compaction: ClaudeCompaction; t: Translate }) {
  const { trigger, preTokens, postTokens } = compaction
  const label = trigger === 'auto' ? t('compactedAuto') : t('compacted')
  const shrink = preTokens === undefined || postTokens === undefined
    ? undefined
    : `${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)}`
  return (
    <div className="dsh-claude-compaction" role="separator">
      <span className="dsh-claude-compaction-label">{shrink === undefined ? label : `${label} · ${shrink}`}</span>
    </div>
  )
}

type ToolRecord = Record<string, unknown>

function parsedValue(value: string | undefined): unknown {
  if (value === undefined || value.length === 0) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function record(value: unknown): ToolRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ToolRecord : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function displayValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(displayValue).join(', ')
  return record(value) === undefined ? String(value) : Object.entries(value as ToolRecord)
    .map(([key, item]) => `${key}: ${displayValue(item)}`)
    .join('\n')
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="dsh-claude-tool-section"><div className="dsh-claude-tool-section-title">{title}</div>{children}</section>
}

function Fields({ value, omit = [] }: { value: ToolRecord; omit?: readonly string[] }) {
  const entries = Object.entries(value).filter(([key, item]) => !omit.includes(key) && item !== undefined && item !== '')
  if (entries.length === 0) return null
  return <div className="dsh-claude-tool-fields">{entries.map(([key, item]) => (
    <div key={key} style={{ display: 'contents' }}>
      <span className="dsh-claude-tool-field-key">{key.replaceAll('_', ' ')}</span>
      <span className="dsh-claude-tool-field-value">{displayValue(item)}</span>
    </div>
  ))}</div>
}

function Paths({ paths }: { paths: readonly string[] }) {
  if (paths.length === 0) return null
  return <ul className="dsh-claude-tool-paths">{paths.map((path, index) => <li className="dsh-claude-tool-path" key={`${path}:${index}`}>{path}</li>)}</ul>
}

function Source({ content, start = 1 }: { content: string; start?: number }) {
  return <div className="dsh-claude-tool-code">{content.split(/\r?\n/u).map((line, index) => (
    <div className="dsh-claude-tool-code-line" key={index}>
      <span className="dsh-claude-tool-line-number">{start + index}</span>
      <span className="dsh-claude-tool-line-text">{line || ' '}</span>
    </div>
  ))}</div>
}

/** The command as a shell prompt rather than a labelled field: it was typed
 *  at one, and the prompt is what tells a reader that at a glance. */
function Terminal({ command }: { command: string }) {
  return (
    <div className="dsh-claude-tool-terminal">
      <span className="dsh-claude-tool-prompt" aria-hidden="true">$</span>
      <pre className="dsh-claude-tool-command">{command}</pre>
    </div>
  )
}

function TextDetail({ title, value }: { title: string; value: string | undefined }) {
  if (value === undefined || value.length === 0) return null
  return <Section title={title}><pre className="dsh-claude-tool-detail">{value}</pre></Section>
}

function filenameList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** The diff card's chrome, which primitives 0.1.2 moved onto the caller.
 *
 *  The Host reads `labels.copy` while it builds the card, so a 0.1.2 Host given
 *  no labels throws mid-render -- and React answers by tearing down the whole
 *  conversation, not the one tool row. This repository develops against 0.1.1,
 *  whose declaration does not know the prop yet and whose build ignores it, so
 *  the labels travel as a spread that both versions accept.
 *
 *  The aria strings deliberately repeat the visible ones: both already say
 *  exactly what the control does. */
interface DiffCardLabels {
  copy: string
  copied: string
  collapse: string
  collapseAria: string
  expand: (hidden: number) => string
  expandAria: (hidden: number) => string
  files: (count: number) => string
}

export function diffBlockLabels(t: Translate): DiffCardLabels {
  const expand = (hidden: number): string => t('diffCardExpand', { count: hidden })
  return {
    copy: t('markdownCopy'),
    copied: t('markdownCopied'),
    collapse: t('diffCardCollapse'),
    collapseAria: t('diffCardCollapse'),
    expand,
    expandAria: expand,
    files: count => t('diffCardFiles', { count }),
  }
}

function ToolPresentation({ tool, t }: { tool: ClaudeTranscriptTool; t: Translate }) {
  const inputValue = parsedValue(tool.input)
  const outputValue = parsedValue(tool.output)
  const input = record(inputValue)
  const output = record(outputValue)
  const outputTitle = tool.isError === true ? t('toolError') : t('toolOutput')

  if (tool.diffs !== undefined) {
    const diffProps = { diffs: [...tool.diffs], labels: diffBlockLabels(t) }
    return <><DiffBlock {...diffProps} /><TextDetail title={outputTitle} value={typeof outputValue === 'string' ? outputValue : undefined} /></>
  }

  if (tool.toolName === 'Read') {
    const file = record(output?.file)
    const path = text(file?.filePath) ?? text(input?.file_path)
    const content = text(file?.content) ?? (typeof outputValue === 'string' ? outputValue : undefined)
    const offset = numberValue(input?.offset) ?? 1
    return <>
      {path === undefined ? null : <Section title="File"><div className="dsh-claude-tool-path">{path}</div></Section>}
      {input === undefined ? null : <Section title={t('toolInput')}><Fields value={input} omit={['file_path']} /></Section>}
      {content === undefined ? null : <Section title={outputTitle}><Source content={content} start={offset} /></Section>}
    </>
  }

  if (tool.toolName === 'Grep' || tool.toolName === 'Glob') {
    const filenames = filenameList(output?.filenames)
    return <>
      {input === undefined ? <TextDetail title={t('toolInput')} value={typeof inputValue === 'string' ? inputValue : undefined} /> : <Section title={t('toolInput')}><Fields value={input} /></Section>}
      {filenames.length === 0
        ? <TextDetail title={outputTitle} value={typeof outputValue === 'string' ? outputValue : output === undefined ? undefined : displayValue(output)} />
        : <Section title={outputTitle}><Paths paths={filenames} /></Section>}
    </>
  }

  if (tool.toolName === 'Bash' || tool.toolName === 'PowerShell') {
    const command = text(input?.command)
    const stdout = text(output?.stdout)
    const stderr = text(output?.stderr)
    const terminal = [stdout, stderr].filter((value): value is string => value !== undefined).join('\n')
    const typed = command ?? (typeof inputValue === 'string' ? inputValue : undefined)
    return <>
      {typed === undefined ? null : <Terminal command={typed} />}
      {input === undefined ? null : <Section title={t('toolInput')}><Fields value={input} omit={['command', 'description']} /></Section>}
      <TextDetail title={outputTitle} value={terminal || (typeof outputValue === 'string' ? outputValue : undefined)} />
    </>
  }

  return <>
    {input === undefined ? <TextDetail title={t('toolInput')} value={typeof inputValue === 'string' ? inputValue : undefined} /> : <Section title={t('toolInput')}><Fields value={input} /></Section>}
    {output === undefined ? <TextDetail title={outputTitle} value={typeof outputValue === 'string' ? outputValue : undefined} /> : <Section title={outputTitle}><Fields value={output} /></Section>}
  </>
}

export function ClaudeTranscriptToolItem({ tool, t }: { tool: ClaudeTranscriptTool; t: Translate }) {
  return (
    <details className="dsh-claude-tool-item">
      <summary className="dsh-claude-tool-summary-row">
        <span className="dsh-claude-tool-label">{tool.toolName}</span>
        <span className="dsh-claude-tool-description">{tool.description}</span>
        {tool.additions === undefined && tool.deletions === undefined ? null : (
          <span className="dsh-claude-tool-stats">
            <span className="dsh-claude-diff-add">+{tool.additions ?? 0}</span>
            <span className="dsh-claude-diff-delete">−{tool.deletions ?? 0}</span>
          </span>
        )}
      </summary>
      <div className="dsh-claude-tool-content">
        {tool.subcalls.length === 0 ? null : (
          <div className="dsh-claude-flow-subcalls">
            {tool.subcalls.map(subcall => (
              <div key={subcall.toolUseId}>{subcallGlyph(subcall)} {subcall.toolName ?? t('subagent')}{subcall.summary === undefined ? '' : ` · ${subcall.summary}`}</div>
            ))}
          </div>
        )}
        <ToolPresentation tool={tool} t={t} />
      </div>
    </details>
  )
}

export function ClaudeTranscriptToolGroup({
  tools,
  additions,
  deletions,
  files: _files,
  t,
}: {
  tools: readonly ClaudeTranscriptTool[]
  additions?: number
  deletions?: number
  files?: number
  t: Translate
}) {
  const [open, setOpen] = useState(false)
  const failed = tools.some(tool => tool.isError === true || tool.phase === 'failed')
  const running = tools.some(tool => tool.phase === 'started' || tool.phase === 'updated')
  const summary = tools.length === 1 ? t('usedTool') : t('usedTools', { count: tools.length })
  const hasDiff = additions !== undefined || deletions !== undefined
  return (
    <div className="dsh-claude-tool-group-native">
      <DisclosureRow
        rowClassName="dsh-claude-flow-row"
        leadingClassName="dsh-claude-flow-leading"
        titleClassName="dsh-claude-flow-title"
        chevronClassName="dsh-claude-flow-chevron"
        icon={failed ? <StateDot state="error" /> : running ? <StateDot state="ongoing" /> : <IconApiOutline14 size={14} />}
        title={summary}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen(value => !value)}
        collapsedContent={hasDiff ? (
          <span className="dsh-claude-tool-stats">
            <span className="dsh-claude-diff-add">+{additions ?? 0}</span>
            <span className="dsh-claude-diff-delete">−{deletions ?? 0}</span>
          </span>
        ) : undefined}
      />
      {open ? (
        <div className="dsh-claude-tool-list">
          {tools.map(tool => <ClaudeTranscriptToolItem key={tool.toolUseId} tool={tool} t={t} />)}
        </div>
      ) : null}
    </div>
  )
}

/** Round a duration the way a reader reads one: no more precision than the
 *  number deserves. */
export function formatTurnDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

/** Share of the prompt that was served from cache.
 *
 *  Cache reads are counted against everything the prompt cost to assemble --
 *  fresh input and cache writes included -- so a turn that read nothing scores
 *  zero rather than dividing by nothing. */
export function cacheHitRate(usage: ClaudeUsage): number | undefined {
  const read = usage.cacheReadTokens ?? 0
  const total = read + (usage.cacheCreationTokens ?? 0) + (usage.inputTokens ?? 0)
  return total === 0 ? undefined : read / total
}

/** The turn's accounting, in the order a reader wants it: size, then cost of
 *  assembling it, then how long it took, then money. */
export function turnUsageParts(usage: ClaudeUsage, t: Translate): readonly string[] {
  const tokens = (usage.inputTokens ?? 0)
    + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheCreationTokens ?? 0)
  const cached = cacheHitRate(usage)
  const parts: string[] = []
  if (tokens > 0) parts.push(t('turnUsageTokens', { count: formatTokenCount(tokens) }))
  if (cached !== undefined) parts.push(t('turnUsageCache', { percent: (cached * 100).toFixed(1) }))
  if (usage.durationMs !== undefined) parts.push(formatTurnDuration(usage.durationMs))
  if (usage.ttftMs !== undefined) parts.push(t('turnUsageTtft', { duration: formatTurnDuration(usage.ttftMs) }))
  if (usage.cumulativeCostUsd !== undefined) parts.push(t('turnUsageCost', { cost: usage.cumulativeCostUsd.toFixed(2) }))
  return parts
}

/** The footer the Host draws under its own assistant message, drawn here for
 *  the steps the Host never had a message for. */
export function ClaudeTurnUsage({ usage, t }: { usage: ClaudeUsage; t: Translate }) {
  const parts = turnUsageParts(usage, t)
  if (parts.length === 0) return null
  return (
    <div className="dsh-claude-turn-usage">
      <span className="dsh-claude-turn-usage-label">{t('turnUsage')}</span>
      <span aria-hidden="true">·</span>
      <span>{parts.join(' · ')}</span>
    </div>
  )
}

export function ClaudeActivityNode({ node, useClaudeProjection, t }: ClaudeActivityNodeProps) {
  ensureCss()
  const marker = node.data
  const activities = useClaudeProjection(value => selectStepActivities(value, marker.turn, marker.step))
  const tasks = useClaudeProjection(value => value.tasks?.tasks ?? EMPTY_TASKS)
  const items = useMemo(
    () => transcriptItemsForStep(activities, marker.turn, marker.step, tasks),
    [activities, marker.step, marker.turn, tasks],
  )
  const markdownLabels = useClaudeMarkdownLabels(t)
  if (items.length === 0) return null
  return (
    <div className="dsh-claude-flow">
      {items.map(item => item.kind === 'text'
        ? <div className="dsh-claude-transcript-text" key={`text:${item.ordinal}`}><ClaudeMarkdown text={item.text} labels={markdownLabels} /></div>
        : item.kind === 'compaction'
        ? <ClaudeCompactionDivider key={`compaction:${item.ordinal}`} compaction={item.compaction} t={t} />
        : item.kind === 'usage'
        ? <ClaudeTurnUsage key={`usage:${item.ordinal}`} usage={item.usage} t={t} />
        : item.kind === 'tools'
          ? <ClaudeTranscriptToolGroup
              key={`tools:${item.ordinal}`}
              tools={item.tools}
              {...(item.additions === undefined ? {} : { additions: item.additions })}
              {...(item.deletions === undefined ? {} : { deletions: item.deletions })}
              {...(item.files === undefined ? {} : { files: item.files })}
              t={t}
            />
          : <ActivityRow key={`activity:${item.ordinal}`} row={item.row} t={t} />)}
    </div>
  )
}
