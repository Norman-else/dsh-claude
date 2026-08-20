import { useMemo } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
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

export function ClaudeActivityTail({ matched, useClaudeProjection, t, openTasks }: ClaudeActivityTailProps) {
  const projection = useClaudeProjection(value => value)
  const summary = useMemo(
    () => summarizeTurnTasks(tasksForTurn(projection.tasks?.tasks ?? [], matched.turn)),
    [projection.tasks, matched.turn],
  )
  if (summary === undefined) return null
  const label = summary.state === 'running'
    ? t('tasksTurnRunning', { count: summary.running })
    : summary.state === 'failed'
      ? t('tasksTurnFailed', { failed: summary.failed, completed: summary.completed })
      : t('tasksTurnCompleted', { count: summary.completed })
  const glyph = summary.state === 'running' ? '●' : summary.state === 'failed' ? '×' : '✓'
  return (
    <div data-claude-activity-tail={matched.turn}>
      <button type="button" style={styles.tasksTurnLauncher} onClick={() => openTasks(matched.turn)}>
        <span
          className={summary.state === 'running' ? 'dsh-claude-act-running' : undefined}
          style={{
            ...styles.tasksTurnLauncherDot,
            ...(summary.state === 'failed' ? styles.iconChipError : {}),
            ...(summary.state === 'completed' ? styles.tasksTurnLauncherDone : {}),
          }}
          aria-hidden="true"
        >{glyph}</span>
        <span>{label}</span>
        <span aria-hidden="true">›</span>
      </button>
    </div>
  )
}
