import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RepositoryStatus } from '../repository-status.ts'
import { autoFixEnabled } from './auto-fix.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import * as styles from './styles.ts'

export interface OverviewSessionRow {
  readonly id: string
  readonly displayTitle?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly running?: boolean
  readonly blank?: boolean
}

export interface OverviewSessionsStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): { readonly byId: Readonly<Record<string, OverviewSessionRow | undefined>> }
}

export interface ClaudePullRequestsPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  closeDetails: () => void
  openSession: (sessionId: string) => void
  loadStatus: (cwd: string, signal?: AbortSignal) => Promise<RepositoryStatus>
  sessions: OverviewSessionsStore
}

export const OVERVIEW_REFRESH_MS = 30_000

/** Claude sessions worth listing: non-blank, with a checkout; running first. */
export function claudeSessionRows(byId: Readonly<Record<string, OverviewSessionRow | undefined>>): readonly OverviewSessionRow[] {
  return Object.values(byId)
    .filter((row): row is OverviewSessionRow => row !== undefined && row.agentPreset === 'claude' && row.blank !== true && typeof row.cwd === 'string')
    .sort((left, right) => Number(right.running === true) - Number(left.running === true) || (left.displayTitle ?? left.id).localeCompare(right.displayTitle ?? right.id))
}

function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'error' | 'merged' }) {
  const toneStyle = tone === 'success'
    ? styles.repositoryItemSuccess
    : tone === 'warning' ? styles.repositoryItemWarning : tone === 'error' ? styles.repositoryItemError : tone === 'merged' ? { color: '#a78bfa' } : {}
  return <span style={{ ...styles.repositoryItem, ...toneStyle }}><span style={styles.repositoryItemDot} aria-hidden="true" /><span style={styles.repositoryItemLabel}>{label}</span></span>
}

function repositoryName(remote: string | undefined): string | undefined {
  return remote?.split('/').at(-1)
}

export function ClaudePullRequestsPanel({ t, closeDetails, openSession, loadStatus, sessions }: ClaudePullRequestsPanelInjected) {
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot)
  const rows = useMemo(() => claudeSessionRows(snapshot.byId), [snapshot.byId])
  const cwdKey = useMemo(() => [...new Set(rows.map(row => row.cwd ?? ''))].sort().join('\0'), [rows])
  const [statuses, setStatuses] = useState<Readonly<Record<string, RepositoryStatus>>>({})
  useEffect(() => {
    const cwds = cwdKey.length === 0 ? [] : cwdKey.split('\0')
    if (cwds.length === 0) return
    const controller = new AbortController()
    const refresh = (): void => {
      for (const cwd of cwds) {
        void loadStatus(cwd, controller.signal).then(status => {
          if (!controller.signal.aborted) setStatuses(previous => ({ ...previous, [cwd]: status }))
        }, () => undefined)
      }
    }
    refresh()
    const timer = setInterval(refresh, OVERVIEW_REFRESH_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [cwdKey, loadStatus])
  return (
    <div style={styles.tasksPanel}>
      <style data-dsh-claude-overview-styles>{styles.panelIconButtonCss}</style>
      <header style={styles.tasksHeader}>
        <div>
          <span style={styles.tasksHeading}>{t('overviewTitle')}</span>
          <span style={styles.tasksTurnMeta}>{t('overviewBody')}</span>
        </div>
        <button type="button" className={styles.panelIconButtonClass} aria-label={t('diffClose')} onClick={closeDetails}><IconCloseOutline16 /></button>
      </header>
      <div style={styles.overviewBody}>
        {rows.length === 0 ? <p style={styles.overviewEmpty}>{t('overviewEmpty')}</p> : rows.map(row => {
          const repository = row.cwd === undefined ? undefined : statuses[row.cwd]
          const pullRequest = repository?.pullRequest
          const branch = repository?.status === 'ready'
            ? (repository.detached === true ? t('repositoryDetached') : repository.branch ?? t('repositoryUnknownBranch'))
            : repository === undefined ? t('overviewLoading') : t('repositoryUnavailable')
          return (
            <button key={row.id} type="button" style={styles.overviewRow} onClick={() => { openSession(row.id) }}>
              <span style={styles.overviewRowTop}>
                {row.running === true ? <span style={styles.overviewRunningDot} aria-label={t('overviewRunning')} /> : null}
                <span style={styles.overviewTitle}>{row.displayTitle ?? row.id}</span>
                {pullRequest === undefined
                  ? <Badge label={t('overviewNoPr')} />
                  : <Badge label={`#${pullRequest.number} · ${t(`repositoryState_${pullRequest.state}` as ClaudeCodeSettingsKey)}`} tone={pullRequest.state === 'merged' ? 'merged' : pullRequest.state === 'open' ? 'success' : 'neutral'} />}
              </span>
              <span style={styles.overviewMeta}>
                {repositoryName(repository?.remote) === undefined ? null : <span>{repositoryName(repository?.remote)}</span>}
                <span style={styles.overviewBranch}>{branch}</span>
                {pullRequest?.state === 'open' && pullRequest.checks !== 'none'
                  ? <Badge label={t(`repositoryChecks_${pullRequest.checks}` as ClaudeCodeSettingsKey)} tone={pullRequest.checks === 'passing' ? 'success' : pullRequest.checks === 'failing' ? 'error' : 'warning'} />
                  : null}
                {pullRequest?.state === 'open' && pullRequest.review !== 'none'
                  ? <Badge label={t(`repositoryReview_${pullRequest.review}` as ClaudeCodeSettingsKey)} tone={pullRequest.review === 'approved' ? 'success' : pullRequest.review === 'changes-requested' ? 'error' : 'neutral'} />
                  : null}
                {autoFixEnabled(row.id) ? <Badge label={t('overviewAutoFix')} tone="success" /> : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
