import { useMemo } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeTurnMarker } from './conversation-sidecar.ts'
import { runningTasksForTurn } from './ClaudeTasksPanel.tsx'
import * as styles from './styles.ts'

export interface ClaudeActivityTailInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  openTasks: () => void
}

export interface ClaudeActivityTailProps extends ClaudeActivityTailInjected {
  matched: ClaudeTurnMarker
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

export function ClaudeActivityTail({ matched, useClaudeProjection, t, openTasks }: ClaudeActivityTailProps) {
  const projection = useClaudeProjection(value => value)
  const runningTasks = useMemo(
    () => runningTasksForTurn(projection.tasks?.tasks ?? [], matched.turn),
    [projection.tasks, matched.turn],
  )
  if (runningTasks.length === 0) return null
  return (
    <div data-claude-activity-tail={matched.turn}>
      {runningTasks.length === 0 ? null : (
        <button type="button" style={styles.tasksTurnLauncher} onClick={openTasks}>
          <span className="dsh-claude-act-running" style={styles.tasksTurnLauncherDot} aria-hidden="true">●</span>
          <span>{t('tasksRunningCount', { count: runningTasks.length })}</span>
          <span aria-hidden="true">›</span>
        </button>
      )}
    </div>
  )
}
