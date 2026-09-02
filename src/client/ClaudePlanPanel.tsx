import { useEffect } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import { ClaudeMarkdown, useClaudeMarkdownLabels } from './markdown-labels.tsx'
import * as styles from './styles.ts'

export interface ClaudePlanPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  closeDetails: () => void
}

export interface ClaudePlanPanelProps extends ClaudePlanPanelInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

const PLAN_TOOL = 'ExitPlanMode'

export type PlanState = 'pending' | 'approved' | 'rejected'

export interface PlanReview {
  readonly toolUseId: string
  readonly plan: string
  readonly turn: number
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
  return { toolUseId, plan: proposal.text, turn: proposal.turn, state }
}

const STATE_LABEL: Record<PlanState, ClaudeCodeSettingsKey> = {
  pending: 'planPending',
  approved: 'planApproved',
  rejected: 'planRejected',
}

/** The plan behind an `ExitPlanMode` approval, as the document it was written
 *  as. The decision itself stays with the Host's approval dialog; this panel
 *  is where the plan is actually read, under the reader's own prose palette. */
export function ClaudePlanPanel({ useClaudeProjection, t, closeDetails }: ClaudePlanPanelProps) {
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
    <div className={styles.detailsCardClass} style={styles.tasksPanel}>
      <style data-dsh-claude-panel-icon-styles>{styles.detailsCardCss}{styles.panelIconButtonCss}</style>
      <div style={styles.tasksHeader}>
        <div>
          <span style={styles.tasksHeading}>{t('planPanelTitle')}</span>
          {review === undefined ? null : (
            <span style={styles.tasksTurnMeta}>{t('tasksTurnNumber', { turn: review.turn })}</span>
          )}
        </div>
        <div style={styles.planHeaderEnd}>
          {review === undefined ? null : (
            <span style={{ ...styles.planBadge, ...(review.state === 'pending' ? styles.planBadgePending : review.state === 'rejected' ? styles.planBadgeRejected : {}) }}>
              {t(STATE_LABEL[review.state])}
            </span>
          )}
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
