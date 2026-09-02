import { useEffect } from 'react'
import { IconCloseOutline16, IconFullscreenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import { ClaudeMarkdown, useClaudeMarkdownLabels } from './markdown-labels.tsx'
import * as styles from './styles.ts'

export interface ClaudePlanPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  closeDetails: () => void
  /** Whether the panel is drawn in the shell overlay rather than the column. */
  maximized: boolean
  toggleMaximized: () => void
}

export interface ClaudePlanPanelProps extends ClaudePlanPanelInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

const PLAN_TOOL = 'ExitPlanMode'

export type PlanState = 'pending' | 'approved' | 'rejected'

export interface PlanReview {
  readonly toolUseId: string
  readonly plan: string
  readonly state: PlanState
}

/** The plan Claude last handed over, and where its approval stands.
 *
 *  The permission bridge writes one `started` record carrying the plan and,
 *  once the user decides, a second record under the same `toolUseId` whose
 *  phase says which way it went. Both arrive on the ordinary activity stream,
 *  so the panel needs no channel of its own — it reads the transcript the
 *  session already has.
 *
 *  The newest plan wins: a session can propose again after a rejection, and
 *  the older proposal is then history rather than something to decide. */
export function latestPlanReview(activities: readonly ClaudeActivityEvent[]): PlanReview | undefined {
  let proposal: ClaudeActivityEvent | undefined
  for (const activity of activities) {
    if (activity.kind !== 'permission' || activity.toolName !== PLAN_TOOL) continue
    if (activity.phase === 'started' && activity.text !== undefined && activity.text.length > 0) proposal = activity
  }
  if (proposal?.text === undefined || proposal.toolUseId === undefined) return undefined
  const { toolUseId } = proposal
  // A `failed` record means the approval could not be recorded at all, which
  // is a denial to Claude and reads as one here.
  let state: PlanState = 'pending'
  for (const activity of activities) {
    if (activity.kind !== 'permission' || activity.toolUseId !== toolUseId) continue
    if (activity.phase === 'completed') state = 'approved'
    else if (activity.phase === 'denied' || activity.phase === 'failed') state = 'rejected'
  }
  return { toolUseId, plan: proposal.text, state }
}

/** The review as one primitive, for readers that only need to know whether it
 *  changed. A snapshot hook keeps its value only while the selection compares
 *  equal, and a fresh object per snapshot would defeat that. Empty string when
 *  the session has proposed nothing. */
export function planReviewKey(activities: readonly ClaudeActivityEvent[]): string {
  const review = latestPlanReview(activities)
  return review === undefined ? '' : `${review.state}:${review.toolUseId}`
}

/** Split what {@link planReviewKey} joined. */
export function parsePlanReviewKey(key: string): { state: PlanState; toolUseId: string } | undefined {
  const cut = key.indexOf(':')
  if (cut < 0) return undefined
  const state = key.slice(0, cut)
  if (state !== 'pending' && state !== 'approved' && state !== 'rejected') return undefined
  return { state, toolUseId: key.slice(cut + 1) }
}

/** Restore-from-maximized: four corners pulling inward. Mirrors the diff
 *  panel's own, which the primitives set has no counterpart for. */
function RestorePanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 5h3V2h1.4v4.4H1.5V5Zm9.9-3h1.4v3h3v1.4h-4.4V2ZM1.5 9.6h4.4V14H4.5v-3h-3V9.6Zm9.9 0h4.4V11h-3v3h-1.4V9.6Z" />
    </svg>
  )
}

const STATE_LABEL: Record<PlanState, ClaudeCodeSettingsKey> = {
  pending: 'planPending',
  approved: 'planApproved',
  rejected: 'planRejected',
}

/** The plan behind an `ExitPlanMode` approval, as the document it was written
 *  as. The decision itself stays with the Host's approval dialog; this panel
 *  is where the plan is actually read, under the reader's own prose palette. */
export function ClaudePlanPanel({ useClaudeProjection, t, closeDetails, maximized, toggleMaximized }: ClaudePlanPanelProps) {
  const markdownLabels = useClaudeMarkdownLabels(t)
  const owned = useClaudeProjection(projection => projection.owned)
  const activities = useClaudeProjection(projection => projection.activities)
  const review = latestPlanReview(activities)
  // Nothing to read means nothing to hold the details column open for.
  useEffect(() => {
    if (!owned || review === undefined) closeDetails()
  }, [closeDetails, owned, review === undefined])
  if (!owned) return null
  return (
    <div className={styles.detailsCardClass} style={{ ...styles.tasksPanel, ...(maximized ? styles.diffPanelMaximized : {}) }}>
      <style data-dsh-claude-panel-icon-styles>{styles.detailsCardCss}{styles.panelIconButtonCss}</style>
      <div style={styles.tasksHeader}>
        {/* Title and state read as one phrase — "Plan · awaiting approval" —
            so they share the left end. The right end is the control group. */}
        <div style={styles.planHeaderStart}>
          <span style={styles.tasksHeading}>{t('planPanelTitle')}</span>
          {review === undefined ? null : (
            <span style={{ ...styles.planBadge, ...(review.state === 'pending' ? styles.planBadgePending : review.state === 'rejected' ? styles.planBadgeRejected : {}) }}>
              {t(STATE_LABEL[review.state])}
            </span>
          )}
        </div>
        <div style={styles.planHeaderEnd}>
          <button type="button" className={styles.panelIconButtonClass} aria-label={maximized ? t('planRestore') : t('planMaximize')} onClick={toggleMaximized}>
            {maximized ? <RestorePanelIcon /> : <IconFullscreenOutline16 />}
          </button>
          <button type="button" className={styles.panelIconButtonClass} aria-label={t('planClose')} onClick={closeDetails}><IconCloseOutline16 /></button>
        </div>
      </div>
      <div style={styles.tasksBody}>
        {review === undefined
          ? <p style={styles.tasksGroupEmpty}>{t('planEmpty')}</p>
          : <>
            {review.state === 'pending' ? <p style={styles.planHint}>{t('planPendingHint')}</p> : null}
            <ClaudeMarkdown text={review.plan} labels={markdownLabels} />
          </>}
      </div>
    </div>
  )
}
