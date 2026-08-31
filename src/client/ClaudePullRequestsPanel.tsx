import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RepositoryStatus } from '../repository-status.ts'
import type { ClaudeActivityEvent } from '../events.ts'
import { autoFixEnabled } from './auto-fix.ts'
import { sessionRowPreset } from './session-preset.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import * as styles from './styles.ts'

export interface OverviewSessionRow {
  readonly id: string
  readonly displayTitle?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly running?: boolean
  readonly blank?: boolean
  readonly origin?: string
  /** Host-computed projection values carried on the list row. Desktop 2.0.4
   *  serves the composed preset here and leaves the summary's own
   *  `agentPreset` unset (see {@link sessionRowPreset}). */
  readonly projectionValues?: { readonly agentPreset?: string }
}

export interface OverviewSessionListState {
  /** Host-list order; deleted sessions leave ids but can linger in byId. */
  readonly ids?: readonly string[]
  readonly byId: Readonly<Record<string, OverviewSessionRow | undefined>>
}

export interface OverviewSessionsStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): OverviewSessionListState
}

export interface OverviewWorkspaceListState {
  /** Registry-global archive set: "deleting" a session archives it here while
   *  it stays in the host session list. */
  readonly archivedSessionIds?: readonly string[]
}

export interface OverviewWorkspacesStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): OverviewWorkspaceListState
}

const NO_WORKSPACE_STATE: OverviewWorkspaceListState = {}

const NO_WORKSPACES: OverviewWorkspacesStore = {
  subscribe: () => () => {},
  getSnapshot: () => NO_WORKSPACE_STATE,
}

export interface OverviewProjectionSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): ClaudeClientProjection
}

export interface ClaudePullRequestsPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  closeDetails: () => void
  openSession: (sessionId: string) => void
  loadStatus: (cwd: string, signal?: AbortSignal) => Promise<RepositoryStatus>
  sessions: OverviewSessionsStore
  /** Workspace registry feed used to hide archived ("deleted") sessions. */
  workspaces?: OverviewWorkspacesStore
  /** Live sidecar projection per session, for attention badges and context usage. */
  projectionFor?: (sessionId: string) => OverviewProjectionSource
}

export const OVERVIEW_REFRESH_MS = 30_000

/** What a running session is blocked on: the latest permission or question
 *  activity that is still in its started phase. */
export function overviewAttention(activities: readonly ClaudeActivityEvent[]): 'permission' | 'question' | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]
    if (activity === undefined || (activity.kind !== 'permission' && activity.kind !== 'question')) continue
    return activity.phase === 'started' ? activity.kind : undefined
  }
  return undefined
}

/** Claude sessions worth listing: rows still in the host list (byId keeps
 *  deleted and breadcrumb rows), non-blank, non-subagent, with a checkout;
 *  running first. */
export function claudeSessionRows(state: OverviewSessionListState, archivedSessionIds: readonly string[] = []): readonly OverviewSessionRow[] {
  const rows = state.ids === undefined ? Object.values(state.byId) : state.ids.map(id => state.byId[id])
  const archived = new Set(archivedSessionIds)
  return rows
    .filter((row): row is OverviewSessionRow => row !== undefined
      && sessionRowPreset(row) === 'claude'
      && row.blank !== true
      && row.origin !== 'subagent'
      && !archived.has(row.id)
      && typeof row.cwd === 'string')
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

function OverviewAttention({ source, running, t }: {
  source: OverviewProjectionSource
  running: boolean
  t: ClaudePullRequestsPanelInjected['t']
}) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  // A pending prompt only blocks a live turn; stale ones from interrupted
  // turns would otherwise flag idle sessions forever.
  const attention = running ? overviewAttention(snapshot.activities) : undefined
  const usage = snapshot.contextUsage
  return <>
    {attention === 'permission' ? <Badge label={t('overviewNeedsPermission')} tone="warning" /> : null}
    {attention === 'question' ? <Badge label={t('overviewNeedsAnswer')} tone="warning" /> : null}
    {usage === undefined ? null : <span>{t('overviewContextUsage', { percentage: usage.percentage })}</span>}
  </>
}

export function ClaudePullRequestsPanel({ t, closeDetails, openSession, loadStatus, sessions, workspaces, projectionFor }: ClaudePullRequestsPanelInjected) {
  // Bound through closures: Desktop 2.0 hands both of these over as class
  // instances whose readers touch `this` (the Workspace list rebuilds its
  // cache inside getSnapshot), so a detached method reference throws.
  const sessionStore = useMemo(() => ({
    subscribe: (listener: () => void) => sessions.subscribe(listener),
    getSnapshot: () => sessions.getSnapshot(),
  }), [sessions])
  const snapshot = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot, sessionStore.getSnapshot)
  const workspaceStore = useMemo(() => {
    const source = workspaces ?? NO_WORKSPACES
    return {
      subscribe: (listener: () => void) => source.subscribe(listener),
      getSnapshot: () => source.getSnapshot(),
    }
  }, [workspaces])
  const workspaceState = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot)
  const rows = useMemo(() => claudeSessionRows(snapshot, workspaceState.archivedSessionIds ?? []), [snapshot, workspaceState])
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
    <div className={styles.detailsCardClass} style={styles.tasksPanel}>
      <style data-dsh-claude-overview-styles>{styles.detailsCardCss}{styles.panelIconButtonCss}</style>
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
                {projectionFor === undefined ? null : <OverviewAttention source={projectionFor(row.id)} running={row.running === true} t={t} />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
