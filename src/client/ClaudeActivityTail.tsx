import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeTaskInfo } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeTurnMarker } from './conversation-sidecar.ts'
import { summarizeTurnTasks, tasksForTurn } from './ClaudeTasksPanel.tsx'
import * as styles from './styles.ts'

const MAX_HOVER_TASKS = 6

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

function taskGlyph(status: ClaudeTaskInfo['status']): { glyph: string; style: CSSProperties } {
  if (status === 'failed') return { glyph: '×', style: styles.tasksHoverGlyphError }
  if (status === 'completed') return { glyph: '✓', style: styles.tasksHoverGlyphDone }
  return { glyph: '●', style: styles.tasksHoverGlyphRunning }
}

export function ClaudeTaskLauncher({ turn, tasks, t, openTasks }: ClaudeTaskLauncherProps) {
  const [hovered, setHovered] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const turnTasks = useMemo(() => tasksForTurn(tasks, turn), [tasks, turn])
  const summary = useMemo(() => summarizeTurnTasks(turnTasks), [turnTasks])
  const open = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = undefined
    setHovered(true)
  }
  const scheduleClose = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setHovered(false)
    }, 350)
  }
  useEffect(() => () => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
  }, [])
  if (summary === undefined) return null
  const label = summary.state === 'running'
    ? t('tasksTurnRunning', { count: summary.running })
    : summary.state === 'failed'
      ? t('tasksTurnFailed', { failed: summary.failed, completed: summary.completed })
      : t('tasksTurnCompleted', { count: summary.completed })
  const stateStyle = summary.state === 'completed' ? styles.tasksBadgeDone : {}
  const dotStyle = summary.state === 'failed'
    ? styles.tasksBadgeDotError
    : summary.state === 'completed' ? styles.tasksBadgeDotDone : {}
  return (
    <div data-claude-task-launcher={turn} style={styles.tasksBadgeWrap}>
      <span
        style={styles.tasksBadgeSeat}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        onFocus={open}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose()
        }}
      >
        {hovered ? (
          <span role="tooltip" style={styles.tasksHoverCard} onMouseEnter={open} onMouseLeave={scheduleClose}>
            <span style={styles.tasksHoverHeader}>{label}</span>
            {turnTasks.slice(0, MAX_HOVER_TASKS).map(task => {
              const { glyph, style } = taskGlyph(task.status)
              return (
                <span key={task.taskId} style={styles.tasksHoverRow}>
                  <span className={task.status === 'running' ? 'dsh-claude-act-running' : undefined} style={{ ...styles.tasksHoverGlyph, ...style }} aria-hidden="true">{glyph}</span>
                  <span style={styles.tasksHoverDesc} title={task.description}>{task.description}</span>
                  {task.subagentType === undefined ? null : <span style={styles.tasksHoverType}>{task.subagentType}</span>}
                </span>
              )
            })}
            {turnTasks.length > MAX_HOVER_TASKS ? <span style={styles.tasksHoverMore}>+{turnTasks.length - MAX_HOVER_TASKS}</span> : null}
            <span style={styles.tasksHoverHint}>{t('tasksOpen')}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="dsh-claude-task-launcher"
          style={{ ...styles.tasksTurnBadge, ...stateStyle, ...(hovered ? styles.tasksBadgeHovered : {}) }}
          aria-label={`${label} — ${t('tasksOpen')}`}
          onClick={() => openTasks(turn)}
        >
          <span
            className={summary.state === 'running' ? 'dsh-claude-act-running' : undefined}
            style={{ ...styles.tasksBadgeDot, ...dotStyle }}
            aria-hidden="true"
          />
          <span style={styles.tasksBadgeLabel}>{label}</span>
        </button>
      </span>
    </div>
  )
}

export function ClaudeActivityTail({ matched, useClaudeProjection, t, openTasks }: ClaudeActivityTailProps) {
  const tasks = useClaudeProjection(value => value.tasks?.tasks ?? [])
  return <ClaudeTaskLauncher turn={matched.turn} tasks={tasks} t={t} openTasks={openTasks} />
}
