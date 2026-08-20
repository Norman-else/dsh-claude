import { useMemo, useState } from 'react'
import {
  DisclosureRow,
  IconApiOutline14,
  IconThinkOutline14,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClaudeActivityEvent } from '../events.ts'
import type { ClaudeActivityChatData, ClaudeSubcall } from './conversation-sidecar.ts'
import { activityRowsForStep } from './conversation-sidecar.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'

type Translate = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string

export type ClaudeActivityNodeProps = Omit<ChatNodeViewProps<'claude-activity-step'>, 't'> & { t: Translate }

const EMPTY_TASKS = [] as const

const ACTIVITY_CSS = [
  '.dsh-claude-flow{display:flex;flex-direction:column;gap:4px}',
  '.dsh-claude-flow-row{position:relative;overflow:hidden}',
  '.dsh-claude-flow-leading{flex-shrink:0}',
  '.dsh-claude-flow-title{font-weight:400}',
  '.dsh-claude-flow-chevron{color:var(--dsw-alias-label-secondary)}',
  '.dsh-claude-flow-separator{width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption);flex:none}',
  '.dsh-claude-flow-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;flex:auto}',
  '.dsh-claude-flow-summary[data-error]{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-claude-flow-body{margin:4px 0 4px 22px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-claude-flow-detail{max-height:260px;overflow:auto;margin:4px 0 4px 4px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap}',
  '.dsh-claude-flow-subcalls{display:flex;flex-direction:column;gap:2px;margin:4px 0 4px 22px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:22px}',
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

export function ClaudeActivityNode({ node, useClaudeProjection, t }: ClaudeActivityNodeProps) {
  ensureCss()
  const marker = node.data
  const activities = useClaudeProjection(value => value.activities)
  const tasks = useClaudeProjection(value => value.tasks?.tasks ?? EMPTY_TASKS)
  const rows = useMemo(
    () => activityRowsForStep(activities, marker.turn, marker.step, tasks),
    [activities, marker.step, marker.turn, tasks],
  )
  if (rows.length === 0) return null
  return <div className="dsh-claude-flow">{rows.map((row, index) => <ActivityRow key={`${row.activity.ordinal}:${index}`} row={row} t={t} />)}</div>
}
