import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent, ClaudeTaskInfo } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'
import { formatTokenCount } from './token-format.ts'

export interface ClaudeTasksPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  closeDetails: () => void
}

export interface ClaudeTasksPanelProps extends ClaudeTasksPanelInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

type StatusKey = 'tasksRunning' | 'tasksCompleted' | 'tasksFailed' | 'tasksStopped' | 'tasksKilled'

const STATUS_LABEL: Record<string, StatusKey> = {
  running: 'tasksRunning',
  completed: 'tasksCompleted',
  failed: 'tasksFailed',
  stopped: 'tasksStopped',
  killed: 'tasksKilled',
}

export function visibleTaskGroups(tasks: readonly ClaudeTaskInfo[], dismissedSettledIds: ReadonlySet<string>) {
  return {
    running: tasks.filter(task => task.status === 'running'),
    finished: tasks.filter(task => task.status !== 'running' && !dismissedSettledIds.has(task.taskId)),
  }
}

export function activitiesForTask(activities: readonly ClaudeActivityEvent[], taskId: string) {
  return activities.filter(activity => activity.taskId === taskId)
}

export function runningTasksForTurn(tasks: readonly ClaudeTaskInfo[], turn: number) {
  return tasks.filter(task => task.status === 'running' && task.originTurn === turn)
}

function statusGlyph(status: ClaudeTaskInfo['status']): string {
  if (status === 'running') return '●'
  if (status === 'completed') return '✓'
  if (status === 'stopped') return '–'
  return '×'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return String(Math.max(1, Math.round(ms))) + 'ms'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return String(seconds) + 's'
  const minutes = Math.floor(seconds / 60)
  return String(minutes) + 'm ' + String(seconds % 60) + 's'
}

function taskMeta(task: ClaudeTaskInfo, t: ClaudeTasksPanelInjected['t']): string[] {
  const parts: string[] = []
  if (task.subagentType !== undefined) parts.push(task.subagentType)
  else if (task.taskType !== undefined) parts.push(task.taskType)
  if (task.usage?.durationMs !== undefined) parts.push(formatDuration(task.usage.durationMs))
  if (task.usage?.totalTokens !== undefined) parts.push(t('tokens', { count: formatTokenCount(task.usage.totalTokens) }))
  if (task.usage?.toolUses !== undefined) parts.push(t('tasksToolUses', { count: task.usage.toolUses }))
  if (task.lastToolName !== undefined) parts.push(t('tasksLastTool', { tool: task.lastToolName }))
  return parts
}

function TaskActivity({ activity, t }: { activity: ClaudeActivityEvent; t: ClaudeTasksPanelInjected['t'] }) {
  return (
    <li style={styles.taskActivityItem}>
      <span style={styles.taskActivityGlyph} aria-hidden="true">{activity.isError === true ? '×' : '›'}</span>
      <div style={styles.taskActivityBody}>
        <p style={styles.taskActivityTitle}>{activity.title ?? activity.kind}</p>
        {activity.summary === undefined ? null : <p style={styles.taskActivitySummary}>{activity.summary}</p>}
        {activity.detail === undefined ? null : (
          <details style={styles.taskActivityDetail}>
            <summary style={styles.taskActivityDetailSummary}>{t('detail')}</summary>
            <pre style={styles.detailCode}>{activity.detail}</pre>
          </details>
        )}
      </div>
    </li>
  )
}

function TaskCard(props: { task: ClaudeTaskInfo; activities: readonly ClaudeActivityEvent[]; t: ClaudeTasksPanelInjected['t'] }) {
  const { task, activities, t } = props
  const [activityOpen, setActivityOpen] = useState(false)
  const running = task.status === 'running'
  const failed = task.status === 'failed' || task.status === 'killed'
  const meta = taskMeta(task, t)
  return (
    <article style={{ ...styles.taskCard, ...(running ? styles.taskCardRunning : {}) }}>
      <div style={styles.taskCardTop}>
        <span className={running ? 'dsh-claude-act-running' : undefined} style={{ ...styles.taskCardGlyph, ...(running ? styles.iconChipRunning : {}), ...(failed ? styles.iconChipError : {}) }} aria-hidden="true">
          {statusGlyph(task.status)}
        </span>
        <div style={styles.taskCardBody}>
          <p style={{ ...styles.taskTitle, ...(failed ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) }}>{task.description}</p>
          <p style={styles.taskStatusLine}>
            <span>{t(STATUS_LABEL[task.status] ?? 'tasksRunning')}</span>
            {task.backgrounded === true ? <><span aria-hidden="true"> · </span><span>{t('tasksBackground')}</span></> : null}
          </p>
        </div>
      </div>
      {meta.length === 0 ? null : <p style={styles.taskMeta}>{meta.join(' · ')}</p>}
      {task.summary === undefined || running ? null : <p style={styles.taskSummary}>{task.summary}</p>}
      {activities.length === 0 ? null : (
        <div style={styles.taskActivitySection}>
          <button type="button" style={styles.taskTextButton} aria-expanded={activityOpen} onClick={() => setActivityOpen(value => !value)}>
            {activityOpen ? t('tasksHideActivity') : t('tasksViewActivity')}
          </button>
          {activityOpen ? <ul style={styles.taskActivityList}>{activities.map(activity => (
            <TaskActivity key={`${activity.turn}:${activity.step}:${activity.ordinal}`} activity={activity} t={t} />
          ))}</ul> : null}
        </div>
      )}
    </article>
  )
}

function GroupHeading(props: { label: string; count: number; collapsed?: boolean; onToggle?: () => void; action?: { label: string; onClick: () => void } }) {
  const { label, count, collapsed, onToggle, action } = props
  const content = <><span>{label}</span><span style={styles.tasksGroupCount}>{count}</span></>
  return (
    <div style={styles.tasksGroupHeading}>
      {onToggle === undefined ? <div style={styles.tasksGroupTitle}>{content}</div> : (
        <button type="button" style={styles.tasksGroupToggle} aria-expanded={!collapsed} onClick={onToggle}>
          <span style={{ ...styles.chevron, ...(collapsed === true ? {} : styles.chevronOpen) }}>›</span>{content}
        </button>
      )}
      {action === undefined ? null : <button type="button" style={styles.taskTextButton} onClick={action.onClick}>{action.label}</button>}
    </div>
  )
}

export function ClaudeTasksPanel({ useClaudeProjection, t, closeDetails }: ClaudeTasksPanelProps) {
  const projection = useClaudeProjection(value => value)
  useEffect(() => {
    if (!projection.owned) closeDetails()
  }, [closeDetails, projection.owned])
  const tasks = projection.tasks?.tasks ?? []
  const [finishedCollapsed, setFinishedCollapsed] = useState(false)
  const [dismissedSettledIds, setDismissedSettledIds] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => visibleTaskGroups(tasks, dismissedSettledIds), [tasks, dismissedSettledIds])
  const taskActivities = useMemo(() => new Map(tasks.map(task => [task.taskId, activitiesForTask(projection.activities, task.taskId)])), [projection.activities, tasks])
  const clearFinished = (): void => setDismissedSettledIds(previous => new Set([
    ...previous,
    ...tasks.filter(task => task.status !== 'running').map(task => task.taskId),
  ]))
  if (!projection.owned) return null
  return (
    <div style={styles.tasksPanel}>
      <div style={styles.tasksHeader}>
        <span style={styles.tasksHeading}>{t('tasksPanel')}</span>
        <button type="button" style={styles.tasksClose} aria-label={t('tasksClose')} onClick={closeDetails}>×</button>
      </div>
      <div style={styles.tasksBody}>
        <section aria-label={t('tasksRunning')}>
          <GroupHeading label={t('tasksRunning')} count={groups.running.length} />
          {groups.running.length === 0 ? <p style={styles.tasksGroupEmpty}>{t('tasksNoneRunning')}</p> : (
            <div style={styles.taskCardList}>{groups.running.map(task => <TaskCard key={task.taskId} task={task} activities={taskActivities.get(task.taskId) ?? []} t={t} />)}</div>
          )}
        </section>
        <section aria-label={t('tasksSettled')} style={styles.tasksFinishedSection}>
          <GroupHeading
            label={t('tasksSettled')}
            count={groups.finished.length}
            collapsed={finishedCollapsed}
            onToggle={() => setFinishedCollapsed(value => !value)}
            {...(groups.finished.length === 0 ? {} : { action: { label: t('tasksClear'), onClick: clearFinished } })}
          />
          {finishedCollapsed || groups.finished.length === 0 ? null : (
            <div style={styles.taskCardList}>{groups.finished.map(task => <TaskCard key={task.taskId} task={task} activities={taskActivities.get(task.taskId) ?? []} t={t} />)}</div>
          )}
        </section>
      </div>
    </div>
  )
}

export interface ClaudeTasksLauncherInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  isOpen: () => boolean
  toggle: () => void
  subscribe: (fn: () => void) => () => void
}

export interface ClaudeTasksHeaderButtonProps extends ClaudeTasksLauncherInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

export function ClaudeTasksHeaderButton({ useClaudeProjection, t, isOpen, toggle, subscribe }: ClaudeTasksHeaderButtonProps) {
  const open = useSyncExternalStore(subscribe, isOpen, isOpen)
  const projection = useClaudeProjection(value => value)
  if (!projection.owned) return null
  const runningCount = projection.tasks?.tasks.filter(task => task.status === 'running').length ?? 0
  return (
    <button
      type="button"
      className="dsh-claude-tasks-trigger"
      style={{ ...styles.tasksHeaderButton, ...(open ? styles.tasksHeaderButtonActive : {}) }}
      aria-label={t('tasksOpen')}
      aria-pressed={open}
      onClick={(event) => {
        toggle()
        event.currentTarget.blur()
      }}
    >
      <style>{styles.tasksTriggerHoverCss}</style>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" />
      </svg>
      <span>{t('tasks')}</span>
      {runningCount === 0 ? null : <span className="dsh-claude-act-running" style={styles.tasksBadgeInline} aria-hidden="true">{runningCount}</span>}
    </button>
  )
}
