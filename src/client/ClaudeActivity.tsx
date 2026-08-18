import type { ClaudeActivityEvent } from '../events.ts'
import type { ClaudeTurnData } from './conversation.ts'
import * as styles from './styles.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'

export interface ClaudeActivityInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

export interface ClaudeActivityProps extends ClaudeActivityInjected {
  matched: ClaudeTurnData
}

function icon(activity: ClaudeActivityEvent): string {
  if (activity.isError === true || activity.kind === 'error') return '×'
  if (activity.kind === 'permission') return activity.phase === 'completed' ? '✓' : activity.phase === 'denied' ? '–' : '?'
  if (activity.kind === 'tool-call') return '›'
  if (activity.kind === 'tool-result') return activity.phase === 'failed' ? '×' : '✓'
  if (activity.kind === 'thinking') return '∿'
  if (activity.kind === 'subagent') return '↳'
  if (activity.kind === 'usage') return '∑'
  return '·'
}

function title(activity: ClaudeActivityEvent): string {
  return activity.title ?? activity.toolName ?? activity.kind.replaceAll('-', ' ')
}

export function ClaudeActivity({ matched, t }: ClaudeActivityProps) {
  const activities = matched.activities
  if (activities.length === 0) return null
  const hasError = activities.some(activity => activity.isError === true || activity.kind === 'error')
  const running = activities.at(-1)?.phase === 'started' || activities.at(-1)?.phase === 'updated'
  return (
    <details style={styles.shell} open={hasError}>
      <summary style={styles.summary}>
        <span aria-hidden="true">{hasError ? '×' : running ? '●' : '◇'}</span>
        <span>{t('activity')}</span>
        <span style={styles.countBadge}>{activities.length}</span>
      </summary>
      <div style={styles.activityList}>
        {activities.map(activity => (
          <div key={`${activity.turn}:${activity.step}:${activity.ordinal}`} style={styles.activityRow}>
            <span style={styles.rail} aria-hidden="true">{icon(activity)}</span>
            <div>
              <p style={{ ...styles.rowTitle, ...(activity.isError === true ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) }}>
                {title(activity)}
              </p>
              {activity.summary === undefined ? null : <p style={styles.rowSummary}>{activity.summary}</p>}
              {activity.detail === undefined ? null : (
                <details>
                  <summary style={styles.detailSummary}>{t('detail')}</summary>
                  <pre style={styles.detailCode}>{activity.detail}</pre>
                </details>
              )}
            </div>
          </div>
        ))}
      </div>
    </details>
  )
}
