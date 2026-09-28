import { useMemo } from 'react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeTaskInfo } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'
import { teammateTranscript } from './conversation-sidecar.ts'
import { ClaudeTranscriptFlow } from './ClaudeActivityNode.tsx'
import { ClaudeMarkdown, useClaudeMarkdownLabels } from './markdown-labels.tsx'
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

/** The Lead's brief reads as the user turn of this conversation, the report
 *  as its closing answer; between them the flow is the chat's own. */
const PANEL_CSS = [
  '.dsh-claude-teammate-meta{display:flex;flex-wrap:wrap;gap:6px 12px;padding:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}',
  '.dsh-claude-teammate-brief{align-self:flex-end;max-width:85%;margin:0 0 12px auto;padding:8px 12px;border-radius:14px 14px 4px 14px;',
    'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-claude-teammate-brief-label{display:block;margin-bottom:2px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
  '.dsh-claude-teammate-report{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))}',
  '.dsh-claude-teammate-report-label{display:block;margin-bottom:4px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
  '.dsh-claude-teammate-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:4px 0}',
].join('')

/** One teammate's conversation: what the Lead asked, what it said and ran, and
 *  what it reported back, drawn with the chat's own transcript renderer. */
export function ClaudeTeammatePanel({ t, closeDetails, taskId, useClaudeProjection }: ClaudeTeammatePanelProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const activities = useClaudeProjection(projection => projection.activities)
  const tasks = useClaudeProjection(projection => projection.tasks?.tasks ?? EMPTY_TASKS)
  const team = useMemo(() => deriveTeam(activities, tasks), [activities, tasks])
  const member = team.members.find(candidate => candidate.taskId === taskId)
  const items = useMemo(
    () => member === undefined ? [] : teammateTranscript(activities, member.taskId, member.toolUseId),
    [activities, member],
  )
  const markdownLabels = useClaudeMarkdownLabels(t)
  if (!owned) return null
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
            <div className="dsh-claude-teammate-brief">
              <span className="dsh-claude-teammate-brief-label">{t('teammateBrief')}</span>
              {member.prompt ?? member.description}
            </div>
            {items.length > 0
              ? <ClaudeTranscriptFlow items={items} t={t} />
              : member.status === 'running' ? <div className="dsh-claude-teammate-empty">{t('teammateWorking')}</div> : null}
            {member.summary === undefined ? null : (
              <div className="dsh-claude-teammate-report">
                <span className="dsh-claude-teammate-report-label">{t('teammateResult')}</span>
                <div className="dsh-claude-transcript-text"><ClaudeMarkdown text={member.summary} labels={markdownLabels} /></div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
