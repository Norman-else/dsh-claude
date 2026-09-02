/** Desktop notifications for the sessions the user is not looking at.
 *
 *  The session board already knows which session is blocked on an approval or
 *  a question and which has gone quiet — but only while it is open, which
 *  makes the user the poller. Running several worktree sessions at once is the
 *  workflow this plugin is built for, and it is the one thing that gets worse
 *  the more of them there are.
 *
 *  Everything here is derived from the two feeds the board already reads, so a
 *  standing watcher costs one more subscriber on the shared projection
 *  carrier rather than a stream per session.
 */
import { DEFAULT_CLAUDE_ALERT_MODE } from '../constants.ts'
import type { ClaudeClientProjection } from './projection.ts'
import {
  claudeSessionRows,
  overviewAttention,
  type OverviewSessionListState,
  type OverviewSessionRow,
} from './ClaudePullRequestsPanel.tsx'
import type { ClaudeCodeSettingsKey } from './locales.ts'

/** ponytail: module state, like the auto-fix toggle next door. The Settings
 *  panel and the boot read both write it, and the watcher reads it per alert,
 *  so switching alerts off lands without a reload. */
let alertsEnabled = DEFAULT_CLAUDE_ALERT_MODE === 'on'

export function claudeAlertsEnabled(): boolean {
  return alertsEnabled
}

export function setClaudeAlertsEnabled(enabled: boolean): void {
  alertsEnabled = enabled
}

/** What one session is doing, as far as an interruption is concerned. */
export interface ClaudeSessionAlertState {
  readonly running: boolean
  readonly attention: 'permission' | 'question' | undefined
}

export type ClaudeSessionAlertKind = 'permission' | 'question' | 'idle'

/** The alert one observation earns, or undefined when nothing happened that is
 *  worth interrupting the user for.
 *
 *  A session observed for the first time earns nothing: the watcher starts
 *  with every session unknown, and announcing the state each one merely
 *  happens to be in would greet a restart with a burst. */
export function sessionAlert(
  previous: ClaudeSessionAlertState | undefined,
  next: ClaudeSessionAlertState,
): ClaudeSessionAlertKind | undefined {
  if (previous === undefined) return undefined
  // A prompt that is still the same prompt has already been announced.
  if (next.attention !== undefined && next.attention !== previous.attention) return next.attention
  if (previous.running && !next.running) return 'idle'
  return undefined
}

/** One alert, ready to deliver. */
export interface ClaudeSessionAlert {
  readonly sessionId: string
  readonly title: string
  readonly body: string
  /** Bring the session on screen; wired to the notification's click. */
  readonly open: () => void
}

/** Deliver one alert as a desktop notification.
 *
 *  Best effort throughout: a Host without the Notification API, or a user who
 *  has refused permission, simply gets no alerts. The tag collapses repeat
 *  alerts for one session into a single banner rather than a stack. */
export function postSessionAlert(alert: ClaudeSessionAlert): void {
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return
  const show = (): void => {
    try {
      const notification = new Notification(alert.title, { body: alert.body, tag: `dsh-claude:${alert.sessionId}` })
      notification.onclick = () => {
        globalThis.focus?.()
        alert.open()
      }
    } catch {
      // Some Hosts expose the constructor without a working backend.
    }
  }
  if (Notification.permission === 'granted') show()
  else void Notification.requestPermission().then(result => { if (result === 'granted') show() }, () => undefined)
}

export interface ClaudeSessionAlertsDeps {
  /** Host session list: per-session run state, plus the session on screen. */
  sessions: {
    subscribe(listener: () => void): () => void
    getSnapshot(): OverviewSessionListState & { readonly current?: string }
  }
  /** Live sidecar projection of one session, for what it is blocked on. */
  projectionFor: (sessionId: string) => {
    subscribe(listener: () => void): () => void
    getSnapshot(): ClaudeClientProjection
  }
  open: (sessionId: string) => void
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Read at delivery time, so turning alerts off in Settings lands at once. */
  enabled?: () => boolean
  post?: (alert: ClaudeSessionAlert) => void
}

const BODY_KEY: Readonly<Record<ClaudeSessionAlertKind, ClaudeCodeSettingsKey>> = {
  permission: 'alertNeedsPermission',
  question: 'alertNeedsAnswer',
  idle: 'alertTurnFinished',
}

/** Watch every Claude session and announce the ones that need the user.
 *  Returns the unsubscriber. */
export function startClaudeSessionAlerts(deps: ClaudeSessionAlertsDeps): () => void {
  const post = deps.post ?? postSessionAlert
  const known = new Map<string, ClaudeSessionAlertState>()
  const projections = new Map<string, () => void>()
  let disposed = false

  const announce = (row: OverviewSessionRow, kind: ClaudeSessionAlertKind): void => {
    if (!(deps.enabled ?? claudeAlertsEnabled)()) return
    post({
      sessionId: row.id,
      title: row.displayTitle ?? deps.t('alertFallbackTitle'),
      body: deps.t(BODY_KEY[kind]),
      open: () => { deps.open(row.id) },
    })
  }

  const evaluate = (): void => {
    if (disposed) return
    const snapshot = deps.sessions.getSnapshot()
    const rows = claudeSessionRows(snapshot)
    const live = new Set(rows.map(row => row.id))
    // A session that left the list starts over if it comes back; its old state
    // would otherwise make the first observation after a reload look like a
    // transition.
    for (const [sessionId, unsubscribe] of [...projections]) {
      if (live.has(sessionId)) continue
      unsubscribe()
      projections.delete(sessionId)
      known.delete(sessionId)
    }
    for (const row of rows) {
      const source = deps.projectionFor(row.id)
      if (!projections.has(row.id)) projections.set(row.id, source.subscribe(evaluate))
      const running = row.running === true
      // A prompt only blocks a live turn; a stale one left by an interrupted
      // turn must not keep announcing an idle session.
      const next: ClaudeSessionAlertState = {
        running,
        attention: running ? overviewAttention(source.getSnapshot().activities) : undefined,
      }
      const previous = known.get(row.id)
      known.set(row.id, next)
      // No notification for the session on screen: the user is looking at it.
      // Its state is still recorded, so switching away does not replay it.
      if (row.id === snapshot.current) continue
      const kind = sessionAlert(previous, next)
      if (kind !== undefined) announce(row, kind)
    }
  }

  const unsubscribe = deps.sessions.subscribe(evaluate)
  evaluate()
  return () => {
    disposed = true
    unsubscribe()
    for (const dispose of projections.values()) dispose()
    projections.clear()
    known.clear()
  }
}
