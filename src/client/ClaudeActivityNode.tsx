import { useMemo, useState } from 'react'
import {
  DiffBlock,
  DisclosureRow,
  IconApiOutline14,
  IconThinkOutline14,
  MarkdownText,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClaudeActivityEvent } from '../events.ts'
import type { ClaudeActivityChatData, ClaudeSubcall, ClaudeTranscriptTool } from './conversation-sidecar.ts'
import { transcriptItemsForStep } from './conversation-sidecar.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'

type Translate = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string

export type ClaudeActivityNodeProps = Omit<ChatNodeViewProps<'claude-activity-step'>, 't'> & { t: Translate }

const EMPTY_TASKS = [] as const

const ACTIVITY_CSS = [
  '.dsh-claude-flow{display:flex;flex-direction:column;gap:4px}',
  '.dsh-claude-transcript-text{color:var(--dsw-alias-label-primary);font-size:15px;line-height:24px;overflow-wrap:anywhere}',
  '.dsh-claude-tool-group-native{overflow:visible}',
  '.dsh-claude-tool-group-native>.dsh-claude-flow-row{padding:0}',
  '.dsh-claude-tool-list{overflow:hidden;margin-top:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}',
  '.dsh-claude-tool-item{border-top:1px solid var(--dsw-alias-border-l1)}',
  '.dsh-claude-tool-item:first-child{border-top:0}',
  '.dsh-claude-tool-summary-row{display:flex;align-items:center;min-height:34px;gap:8px;padding:0 10px;cursor:pointer;list-style:none}',
  '.dsh-claude-tool-summary-row::-webkit-details-marker{display:none}',
  '.dsh-claude-tool-summary-row::after{content:"›";margin-left:2px;flex:none;align-self:center;color:var(--dsw-alias-label-secondary);font-size:22px;line-height:1;transform-origin:center;transition:transform .15s ease}',
  '.dsh-claude-tool-item[open]>.dsh-claude-tool-summary-row::after{transform:rotate(90deg)}',
  '.dsh-claude-tool-content{padding:0 10px 8px}',
  '.dsh-claude-tool-label{width:72px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-claude-tool-description{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-tool-stats{display:inline-flex;gap:4px;flex:none;font-size:13px;line-height:20px}',
  '.dsh-claude-diff-add{color:var(--dsw-alias-state-success-primary,#21c55d)}',
  '.dsh-claude-diff-delete{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-claude-tool-name{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-tool-summary{margin-left:8px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-claude-tool-detail{margin:6px 0 0;padding:8px 10px;max-height:220px;overflow:auto;border-radius:8px;background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;overflow-wrap:anywhere}',
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

function ToolDetail({ label, value }: { label: string; value: string | undefined }) {
  if (value === undefined || value.length === 0) return null
  return <pre className="dsh-claude-tool-detail">{`${label}\n${value}`}</pre>
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
        {tool.diffs === undefined ? <ToolDetail label={t('toolInput')} value={tool.input} /> : null}
        {tool.diffs === undefined ? null : <DiffBlock diffs={[...tool.diffs]} />}
        <ToolDetail label={tool.isError === true ? t('toolError') : t('toolOutput')} value={tool.output} />
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

export function ClaudeActivityNode({ node, useClaudeProjection, t }: ClaudeActivityNodeProps) {
  ensureCss()
  const marker = node.data
  const activities = useClaudeProjection(value => value.activities)
  const tasks = useClaudeProjection(value => value.tasks?.tasks ?? EMPTY_TASKS)
  const items = useMemo(
    () => transcriptItemsForStep(activities, marker.turn, marker.step, tasks),
    [activities, marker.step, marker.turn, tasks],
  )
  if (items.length === 0) return null
  return (
    <div className="dsh-claude-flow">
      {items.map(item => item.kind === 'text'
        ? <div className="dsh-claude-transcript-text" key={`text:${item.ordinal}`}><MarkdownText text={item.text} /></div>
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
