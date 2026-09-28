import { useMemo, useRef, useState } from 'react'
import { IconUsersOutlineRegular, Tooltip, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeTaskInfo } from '../events.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { LEAD_NAME, deriveTeam, memberStatusKey, taskStatusKey, type ClaudeTeamMember } from './team.ts'

export interface ClaudeTeamHeaderActionInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Open one teammate's own conversation in the right sidebar. */
  openTeammate: (taskId: string) => void
}

export interface ClaudeTeamHeaderActionProps extends ClaudeTeamHeaderActionInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  sessionId: string
}

const EMPTY_TASKS: readonly ClaudeTaskInfo[] = []
const MAX_MESSAGES = 6

/** Same seat and resting look as the diff trigger next to it, and the same
 *  people icon the Host's own team roster wears; the popover borrows the
 *  Host menu surface so it reads as one family with the background-job list. */
const TEAM_CSS = [
  '.dsh-claude-team-root{position:relative;display:inline-flex;flex:none}',
  '.dsh-claude-header-team{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;',
    'min-width:32px;height:32px;padding:0 10px 0 8px;border:0;border-radius:9px;background:transparent;',
    'color:var(--dsw-alias-label-secondary);cursor:pointer;',
    'font-family:var(--dsw-font-family);font-size:12px;line-height:1;font-weight:650;',
    'transition:background .12s ease,color .12s ease}',
  '.dsh-claude-header-team:hover,.dsh-claude-header-team:focus-visible,.dsh-claude-header-team[aria-expanded="true"]{',
    'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-header-team:focus-visible{outline:none}',
  '.dsh-claude-header-team>*{flex:none}',
  '.dsh-claude-header-team>svg{display:block}',
  '.dsh-claude-team-dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-tertiary)}',
  '.dsh-claude-team-dot[data-state="running"]{background:var(--dsw-static-blue-450)}',
  '.dsh-claude-team-dot[data-state="failed"]{background:var(--dsw-alias-state-error-primary)}',
  '.dsh-claude-team-dot[data-state="completed"]{background:var(--dsw-alias-state-success-primary)}',
  '.dsh-claude-team-card{box-sizing:border-box;position:absolute;top:calc(100% + 6px);right:0;z-index:100;',
    'display:flex;flex-direction:column;gap:10px;padding:10px 12px;width:min(380px,80vw);max-height:min(480px,70vh);overflow-y:auto;',
    'border:1px solid var(--dsw-alias-border-inverted);border-radius:10px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);',
    'color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px;line-height:17px;text-align:left}',
  '.dsh-claude-team-section{display:flex;flex-direction:column;gap:2px}',
  '.dsh-claude-team-heading{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;padding:0 4px 2px}',
  '.dsh-claude-team-empty{color:var(--dsw-alias-label-tertiary);padding:2px 4px}',
  '.dsh-claude-team-row{display:flex;align-items:center;gap:8px;width:100%;min-height:26px;padding:4px 6px;',
    'border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left}',
  'button.dsh-claude-team-row{cursor:pointer}',
  'button.dsh-claude-team-row:hover,button.dsh-claude-team-row:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-claude-team-name{flex:none;font-weight:600;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-claude-team-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
  '.dsh-claude-team-chip{flex:none;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;',
    'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dsh-claude-team-chip[data-tone="lead"]{background:color-mix(in srgb,var(--dsw-static-blue-450) 18%,transparent);color:var(--dsw-static-blue-450)}',
  '.dsh-claude-team-status{flex:none;color:var(--dsw-alias-label-tertiary)}',
].join('')

let cssInjected = false
function ensureCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const element = document.createElement('style')
  element.dataset.dshClaudeTeam = ''
  element.textContent = TEAM_CSS
  document.head.appendChild(element)
}

function dotState(members: readonly ClaudeTeamMember[]): 'running' | 'failed' | 'completed' | 'idle' {
  if (members.some(member => member.status === 'running')) return 'running'
  if (members.some(member => member.status === 'failed' || member.status === 'killed')) return 'failed'
  return members.length > 0 ? 'completed' : 'idle'
}

export function ClaudeTeamHeaderAction({ t, sessionId, openTeammate, useClaudeProjection }: ClaudeTeamHeaderActionProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const activities = useClaudeProjection(projection => projection.activities)
  const tasks = useClaudeProjection(projection => projection.tasks?.tasks ?? EMPTY_TASKS)
  const team = useMemo(() => deriveTeam(activities, tasks), [activities, tasks])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  useDismissOnOutsidePointer(rootRef, open, setOpen)
  // Every hook above this line: the slot crashes on a conditional hook.
  if (!owned || (team.members.length === 0 && team.tasks.length === 0)) return null
  ensureCss()
  const state = dotState(team.members)
  const label = t('teamOpen')
  return (
    <span className="dsh-claude-team-root" ref={rootRef} data-session={sessionId}>
      <Tooltip label={label} side="bottom" delayMs={250}>
        <button
          type="button"
          className="dsh-claude-header-team"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => { setOpen(value => !value) }}
        >
          <IconUsersOutlineRegular size={16} />
          <span>{team.members.length + 1}</span>
          <span className="dsh-claude-team-dot" data-state={state} aria-hidden="true" />
        </button>
      </Tooltip>
      {!open ? null : (
        <div className="dsh-claude-team-card" role="dialog" aria-label={t('teamTitle')}>
          <div className="dsh-claude-team-section">
            <div className="dsh-claude-team-heading">{t('teamMembers')}</div>
            <div className="dsh-claude-team-row">
              <span className="dsh-claude-team-dot" data-state="running" aria-hidden="true" />
              <span className="dsh-claude-team-name">{LEAD_NAME}</span>
              <span className="dsh-claude-team-chip" data-tone="lead">{t('teamLead')}</span>
            </div>
            {team.members.map(member => (
              <button
                key={member.taskId}
                type="button"
                className="dsh-claude-team-row"
                aria-label={t('teammateOpen', { name: member.name })}
                onClick={() => {
                  setOpen(false)
                  openTeammate(member.taskId)
                }}
              >
                <span className="dsh-claude-team-dot" data-state={member.status === 'running' ? 'running' : member.status === 'completed' ? 'completed' : 'failed'} aria-hidden="true" />
                <span className="dsh-claude-team-name">{member.name}</span>
                <span className="dsh-claude-team-text" title={member.description}>{member.lastToolName ?? member.description}</span>
                <span className="dsh-claude-team-status">{t(memberStatusKey(member.status))}</span>
              </button>
            ))}
          </div>
          <div className="dsh-claude-team-section">
            <div className="dsh-claude-team-heading">{t('teamTasks')}</div>
            {team.tasks.length === 0 ? <div className="dsh-claude-team-empty">{t('teamNoTasks')}</div> : team.tasks.map(task => (
              <div key={task.id} className="dsh-claude-team-row" title={task.description}>
                <span className="dsh-claude-team-dot" data-state={task.status === 'in_progress' ? 'running' : task.status === 'completed' ? 'completed' : 'idle'} aria-hidden="true" />
                <span className="dsh-claude-team-text" style={{ color: 'inherit' }}>{task.subject}</span>
                {task.owner === undefined ? null : <span className="dsh-claude-team-chip">{task.owner}</span>}
                <span className="dsh-claude-team-status">{t(taskStatusKey(task.status))}</span>
              </div>
            ))}
          </div>
          <div className="dsh-claude-team-section">
            <div className="dsh-claude-team-heading">{t('teamMessages')}</div>
            {team.messages.length === 0 ? <div className="dsh-claude-team-empty">{t('teamNoMessages')}</div> : team.messages.slice(-MAX_MESSAGES).map(message => (
              <div key={message.ordinal} className="dsh-claude-team-row" title={message.message}>
                <span className="dsh-claude-team-name">{message.from} → {message.to}</span>
                <span className="dsh-claude-team-text">{message.summary ?? message.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}
