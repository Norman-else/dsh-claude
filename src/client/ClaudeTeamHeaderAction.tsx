import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { IconUserOutlineRegular, IconUsersOutlineRegular, StateDot, useDismissOnOutsidePointer, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeTaskInfo, ClaudeTaskStatus } from '../events.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { LEAD_NAME, deriveTeam, memberStatusKey, taskStatusKey, type ClaudeTeamTaskStatus } from './team.ts'

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
const MAX_MESSAGES = 8

/** The Host's own team roster, seat for seat: the same trigger in the action
 *  row next to the title and the same fixed panel with member cards and task
 *  cards, so a Claude session's team reads exactly like a native one. The
 *  Host's entry is hidden for Claude sessions in host-chrome.ts. */
const TEAM_CSS = [
  '.dsh-claude-team-root{position:relative;display:inline-flex}',
  '.dsh-claude-team-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;',
    'align-items:center;gap:5px;padding:3px 7px;font-size:12px;font-family:inherit;display:inline-flex}',
  '.dsh-claude-team-trigger:hover,.dsh-claude-team-trigger:focus-visible,.dsh-claude-team-trigger[aria-expanded="true"]{color:var(--dsw-alias-label-primary);outline:none}',
  '@container (width<=480px){.dsh-claude-team-trigger-label{display:none}}',
  '.dsh-claude-team-count{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:12px;font-weight:400;line-height:16px}',
  '.dsh-claude-team-panel{z-index:100;box-sizing:border-box;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:min(500px,100vw - 32px);',
    'max-height:min(680px,100vh - 32px);box-shadow:var(--dsw-elevation-prominent);border:0;border-radius:12px;flex-direction:column;padding:8px 2px 0;display:flex;position:fixed;overflow:hidden;',
    'color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px;line-height:17px}',
  '.dsh-claude-team-panel:before{content:"";z-index:-1;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);border-radius:12px;position:absolute;inset:0}',
  '.dsh-claude-team-panel[data-compact]{width:min(320px,100vw - 32px)}',
  '.dsh-claude-team-panel[data-compact] .dsh-claude-team-roster{grid-template-columns:minmax(0,1fr)}',
  '.dsh-claude-team-body{flex:auto;min-height:0;padding:0 9px 16px 14px;overflow-y:auto;scrollbar-gutter:stable}',
  '.dsh-claude-team-panel h3{color:var(--dsw-alias-label-primary);align-items:center;gap:8px;margin:16px 0 8px 4px;font-size:13px;font-weight:500;display:flex}',
  '.dsh-claude-team-body section:first-of-type h3{margin-top:8px}',
  '.dsh-claude-team-roster{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;display:grid}',
  '.dsh-claude-team-member{--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);min-width:0;box-shadow:var(--dsw-elevation-stroke);background:var(--dsw-alias-bg-layer-2);',
    'color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;border:0;border-radius:8px;align-items:flex-start;gap:8px;padding:10px 12px;display:flex;font:inherit}',
  '.dsh-claude-team-member:disabled{cursor:default}',
  '.dsh-claude-team-member[data-current]{--dsw-elevation-stroke-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);',
    'box-shadow:var(--dsw-elevation-stroke), inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent)}',
  '.dsh-claude-team-member:not(:disabled):hover,.dsh-claude-team-member:not(:disabled):focus-visible{--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel);outline:none}',
  '.dsh-claude-team-member-dot{flex:none;align-items:center;height:1lh;display:inline-flex;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-claude-team-member-text{flex-direction:column;min-width:0;display:flex}',
  '.dsh-claude-team-member-name{align-items:center;gap:5px;min-width:0;display:inline-flex}',
  '.dsh-claude-team-member-name-text,.dsh-claude-team-member-text small{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}',
  '.dsh-claude-team-member-text small,.dsh-claude-team-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}',
  '.dsh-claude-team-tag{flex:0 999 auto;min-width:0;padding:0 4px;border-radius:4px;font-size:10px;line-height:15px;display:inline-block;overflow:hidden;text-overflow:ellipsis;',
    'background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);color:var(--dsw-alias-state-business-primary)}',
  '.dsh-claude-team-tasks{flex-direction:column;gap:7px;display:flex}',
  '.dsh-claude-team-empty{color:var(--dsw-alias-label-tertiary);margin:16px 0 0 4px;font-size:12px}',
  '.dsh-claude-team-task{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:9px;padding:11px 13px}',
  '.dsh-claude-team-task-title{align-items:center;gap:8px;display:flex}',
  '.dsh-claude-team-task-title strong{font-size:13px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-claude-team-task-state{color:var(--dsw-alias-label-tertiary);align-items:center;gap:6px;margin-left:auto;font-size:11px;display:inline-flex;flex:none}',
  '.dsh-claude-team-task p{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;margin:5px 0;font-size:12px;line-height:18px;overflow-wrap:anywhere}',
  '.dsh-claude-team-meta{line-height:20px}.dsh-claude-team-meta>span{margin-right:10px}',
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

function memberDot(status: ClaudeTaskStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'stopped':
    case 'killed': return 'warning'
  }
}

function taskDot(status: ClaudeTeamTaskStatus): StateDotState {
  return status === 'in_progress' ? 'ongoing' : status === 'completed' ? 'done' : 'idle'
}

/** Under the trigger, kept inside the viewport with the Host's 16px margin. */
function panelPosition(trigger: HTMLElement | null): CSSProperties | undefined {
  if (trigger === null || typeof window === 'undefined') return undefined
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(500, window.innerWidth - 32)
  const left = Math.max(16, Math.min(rect.left, window.innerWidth - 16 - width))
  return { left, top: rect.bottom + 6 }
}

export function ClaudeTeamHeaderAction({ t, sessionId, openTeammate, useClaudeProjection }: ClaudeTeamHeaderActionProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const activities = useClaudeProjection(projection => projection.activities)
  const tasks = useClaudeProjection(projection => projection.tasks?.tasks ?? EMPTY_TASKS)
  const team = useMemo(() => deriveTeam(activities, tasks), [activities, tasks])
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useLayoutEffect(() => {
    if (open) setPosition(panelPosition(triggerRef.current))
  }, [open])
  // Every hook above this line: the slot crashes on a conditional hook.
  if (!owned || (team.members.length === 0 && team.tasks.length === 0)) return null
  ensureCss()
  const running = team.members.some(member => member.status === 'running')
  const memberCount = team.members.length + 1
  const label = t('teamTrigger')
  return (
    <div className="dsh-claude-team-root" ref={rootRef} data-session={sessionId}>
      <button
        type="button"
        ref={triggerRef}
        className="dsh-claude-team-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconUsersOutlineRegular size={14} />
        <span className="dsh-claude-team-trigger-label">{label}</span>
        <span className="dsh-claude-team-count">{memberCount}</span>
        {running ? <StateDot state="ongoing" /> : null}
      </button>
      {!open || typeof document === 'undefined' ? null : createPortal(
        <div
          ref={panelRef}
          className="dsh-claude-team-panel"
          data-compact={memberCount <= 2 || undefined}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={label}
        >
          <div className="dsh-claude-team-body">
            <section>
              <h3>{t('teamMembers')}<span className="dsh-claude-team-count">{memberCount}</span></h3>
              <div className="dsh-claude-team-roster">
                <button type="button" className="dsh-claude-team-member" data-current disabled>
                  <span className="dsh-claude-team-member-dot"><IconUserOutlineRegular size={14} /></span>
                  <span className="dsh-claude-team-member-text">
                    <span className="dsh-claude-team-member-name">
                      <span className="dsh-claude-team-member-name-text">{LEAD_NAME}</span>
                      <span className="dsh-claude-team-tag">{t('teamLead')}</span>
                    </span>
                    <small>{t(running ? 'teamStatusRunning' : 'teamLeadIdle')}</small>
                  </span>
                </button>
                {team.members.map(member => (
                  <button
                    key={member.taskId}
                    type="button"
                    className="dsh-claude-team-member"
                    aria-label={t('teammateOpen', { name: member.name })}
                    title={member.description}
                    onClick={() => {
                      setOpen(false)
                      openTeammate(member.taskId)
                    }}
                  >
                    <span className="dsh-claude-team-member-dot"><StateDot state={memberDot(member.status)} /></span>
                    <span className="dsh-claude-team-member-text">
                      <span className="dsh-claude-team-member-name"><span className="dsh-claude-team-member-name-text">{member.name}</span></span>
                      <small>{t(memberStatusKey(member.status))}{member.lastToolName === undefined ? '' : ` · ${member.lastToolName}`}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              {team.tasks.length === 0 ? <p className="dsh-claude-team-empty">{t('teamNoTasks')}</p> : (
                <>
                  <h3>{t('teamTasks')}<span className="dsh-claude-team-count">{team.tasks.length}</span></h3>
                  <div className="dsh-claude-team-tasks">
                    {team.tasks.map(task => (
                      <div key={task.id} className="dsh-claude-team-task">
                        <div className="dsh-claude-team-task-title">
                          <strong>{task.subject}</strong>
                          <span className="dsh-claude-team-task-state"><StateDot state={taskDot(task.status)} />{t(taskStatusKey(task.status))}</span>
                        </div>
                        {task.description === undefined ? null : <p>{task.description}</p>}
                        <div className="dsh-claude-team-meta">
                          <span>{task.owner === undefined ? t('teamTaskUnowned') : t('teamTaskOwner', { owner: task.owner })}</span>
                          {task.blockedBy.length === 0 ? null : <span>{t('teamTaskBlockedBy', { tasks: task.blockedBy.map(id => `#${id}`).join(', ') })}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
            {team.messages.length === 0 ? null : (
              <section>
                <h3>{t('teamMessages')}<span className="dsh-claude-team-count">{team.messages.length}</span></h3>
                <div className="dsh-claude-team-tasks">
                  {team.messages.slice(-MAX_MESSAGES).map(message => (
                    <div key={message.ordinal} className="dsh-claude-team-task">
                      <div className="dsh-claude-team-task-title"><strong>{message.from} → {message.to}</strong></div>
                      <p>{message.summary ?? message.message}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
