import { useMemo, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeTaskInfo } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeTurnMarker } from './conversation-sidecar.ts'
import { summarizeTurnTasks, tasksForTurn } from './ClaudeTasksPanel.tsx'
import * as styles from './styles.ts'

export interface ClaudeActivityTailInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  openTasks: (turn: number) => void
}

export interface ClaudeActivityTailProps extends ClaudeActivityTailInjected {
  matched: ClaudeTurnMarker
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

export interface ClaudeTaskLauncherProps extends ClaudeActivityTailInjected {
  turn: number
  tasks: readonly ClaudeTaskInfo[]
}

export function ClaudeTaskLauncher({ turn, tasks, t, openTasks }: ClaudeTaskLauncherProps) {
  const [interactive, setInteractive] = useState(false)
  const summary = useMemo(
    () => summarizeTurnTasks(tasksForTurn(tasks, turn)),
    [tasks, turn],
  )
  if (summary === undefined) return null
  const label = summary.state === 'running'
    ? t('tasksTurnRunning', { count: summary.running })
    : summary.state === 'failed'
      ? t('tasksTurnFailed', { failed: summary.failed, completed: summary.completed })
      : t('tasksTurnCompleted', { count: summary.completed })
  const glyph = summary.state === 'running' ? '●' : summary.state === 'failed' ? '×' : '✓'
  const settled = summary.state === 'running' && (summary.completed > 0 || summary.failed > 0)
  return (
    <div data-claude-task-launcher={turn} style={styles.tasksTurnLauncherWrap}>
      <button
        type="button"
        className="dsh-claude-task-launcher"
        style={{ ...styles.tasksTurnLauncher, ...(interactive ? styles.tasksTurnLauncherInteractive : {}) }}
        aria-label={t('tasksOpen')}
        onMouseEnter={() => setInteractive(true)}
        onMouseLeave={() => setInteractive(false)}
        onFocus={() => setInteractive(true)}
        onBlur={() => setInteractive(false)}
        onClick={() => openTasks(turn)}
      >
        <span
          className={summary.state === 'running' ? 'dsh-claude-act-running' : undefined}
          style={{
            ...styles.tasksTurnLauncherIcon,
            ...(summary.state === 'failed' ? styles.tasksTurnLauncherIconError : {}),
            ...(summary.state === 'completed' ? styles.tasksTurnLauncherIconDone : {}),
          }}
          aria-hidden="true"
        >{glyph}</span>
        <span style={styles.tasksTurnLauncherTitle}>{label}</span>
        {settled ? (
          <span style={styles.tasksTurnLauncherSettled}>
            {summary.completed === 0 ? null : <span>{`✓ ${summary.completed}`}</span>}
            {summary.failed === 0 ? null : <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{`× ${summary.failed}`}</span>}
          </span>
        ) : null}
        <span style={{ ...styles.tasksTurnLauncherChevron, ...(interactive ? styles.tasksTurnLauncherChevronInteractive : {}) }} aria-hidden="true">›</span>
      </button>
    </div>
  )
}

export function ClaudeActivityTail({ matched, useClaudeProjection, t, openTasks }: ClaudeActivityTailProps) {
  const tasks = useClaudeProjection(value => value.tasks?.tasks ?? [])
  return <ClaudeTaskLauncher turn={matched.turn} tasks={tasks} t={t} openTasks={openTasks} />
}
