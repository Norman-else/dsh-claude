import { useMemo } from 'react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeTaskInfo } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'
import { taskTools } from './conversation-sidecar.ts'
import { ClaudeTranscriptToolItem, ensureActivityCss } from './ClaudeActivityNode.tsx'
import { deriveTeam, memberStatusKey } from './team.ts'

export interface ClaudeTeammatePanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  closeDetails: () => void
  /** The teammate's task id, as the header roster handed it over. */
  taskId: string
}

export interface ClaudeTeammatePanelProps extends ClaudeTeammatePanelInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

const EMPTY_TASKS: readonly ClaudeTaskInfo[] = []

const PANEL_CSS = [
  '.dsh-claude-teammate-meta{display:flex;flex-wrap:wrap;gap:6px 12px;padding:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}',
  '.dsh-claude-teammate-heading{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;margin:10px 0 4px}',
  '.dsh-claude-teammate-empty{color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.dsh-claude-teammate-message{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:17px;margin-bottom:4px}',
  '.dsh-claude-teammate-message-head{color:var(--dsw-alias-label-tertiary);font-size:11px}',
  '.dsh-claude-teammate-message-body{white-space:pre-wrap;overflow-wrap:anywhere}',
].join('')

/** One teammate's own conversation: what it was asked, what it said to whom,
 *  and the tools it ran, folded the way the transcript folds a step. */
export function ClaudeTeammatePanel({ t, closeDetails, taskId, useClaudeProjection }: ClaudeTeammatePanelProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const activities = useClaudeProjection(projection => projection.activities)
  const tasks = useClaudeProjection(projection => projection.tasks?.tasks ?? EMPTY_TASKS)
  const team = useMemo(() => deriveTeam(activities, tasks), [activities, tasks])
  const member = team.members.find(candidate => candidate.taskId === taskId)
  const tools = useMemo(
    () => member === undefined ? [] : taskTools(activities, member.taskId, member.toolUseId),
    [activities, member],
  )
  if (!owned) return null
  ensureActivityCss()
  const messages = member === undefined ? [] : team.messages.filter(message => message.from === member.name || message.to === member.name)
  return (
    <div className={styles.detailsCardClass} style={styles.tasksPanel}>
      <style data-dsh-claude-teammate-styles>{styles.detailsCardCss}{styles.panelIconButtonCss}{PANEL_CSS}</style>
      <div style={styles.tasksHeader}>
        <span style={styles.tasksHeading}>{member?.name ?? t('teammatePanelTitle')}</span>
        <button type="button" className={styles.panelIconButtonClass} aria-label={t('teammateClose')} onClick={closeDetails}>
          <IconCloseOutlineRegular />
        </button>
      </div>
      <div style={styles.tasksBody}>
        {member === undefined ? <div className="dsh-claude-teammate-empty">{t('teammateGone')}</div> : (
          <>
            <div className="dsh-claude-teammate-meta">
              <span>{t(memberStatusKey(member.status))}</span>
              {member.usage?.toolUses === undefined ? null : <span>{t('teammateToolUses', { count: member.usage.toolUses })}</span>}
              {member.lastToolName === undefined ? null : <span>{member.lastToolName}</span>}
            </div>
            <div className="dsh-claude-teammate-message">
              <span className="dsh-claude-teammate-message-head">{t('teammateBrief')}</span>
              <span className="dsh-claude-teammate-message-body">{member.description}</span>
            </div>
            <div className="dsh-claude-teammate-heading">{t('teamMessages')}</div>
            {messages.length === 0 ? <div className="dsh-claude-teammate-empty">{t('teamNoMessages')}</div> : messages.map(message => (
              <div key={message.ordinal} className="dsh-claude-teammate-message">
                <span className="dsh-claude-teammate-message-head">{message.from} → {message.to}{message.summary === undefined ? '' : ` · ${message.summary}`}</span>
                <span className="dsh-claude-teammate-message-body">{message.message}</span>
              </div>
            ))}
            <div className="dsh-claude-teammate-heading">{t('teammateTools')}</div>
            {tools.length === 0 ? <div className="dsh-claude-teammate-empty">{t('teammateNoTools')}</div> : tools.map(tool => (
              <ClaudeTranscriptToolItem key={tool.toolUseId} tool={tool} t={t} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
