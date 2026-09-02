import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeClientProjection } from './projection.ts'
import type { PanelOpenSource } from './panel-open-store.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { parsePlanReviewKey, planReviewKey } from './ClaudePlanPanel.tsx'

export interface ClaudePlanHeaderActionInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Toggle this session's plan panel in the details column. */
  togglePlan: () => void
  /** Whether that panel is currently on screen for this session. */
  planOpen: PanelOpenSource
}

export interface ClaudePlanHeaderActionProps extends ClaudePlanHeaderActionInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  sessionId: string
}

/** Same resting-quiet treatment as the diff action next to it, plus a dot for
 *  a plan still waiting on its approval dialog. */
const ACTION_CSS = [
  '.dsh-claude-header-plan{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;',
    'width:32px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;',
    'color:var(--dsw-alias-label-secondary);cursor:pointer;',
    'transition:background .12s ease,color .12s ease}',
  '.dsh-claude-header-plan:hover,.dsh-claude-header-plan:focus-visible,.dsh-claude-header-plan[aria-pressed="true"]{',
    'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-header-plan:active{background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-claude-header-plan:focus-visible{outline:none}',
  '.dsh-claude-header-plan>*{flex:none}',
  '.dsh-claude-header-plan>svg.dsh-claude-header-plan-glyph{',
    'width:18px;height:18px;display:block;overflow:visible;opacity:1;',
    'fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
  // The dot rides the glyph's top-right corner rather than the button's, so it
  // stays put whether or not the button is showing its hover background.
  '.dsh-claude-header-plan[data-pending]::after{content:"";position:absolute;top:6px;right:6px;',
    'width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-warning-primary,#e2a03f);',
    'box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}',
].join('')

let cssInjected = false
function ensureCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const element = document.createElement('style')
  element.dataset.dshClaudeHeaderPlan = ''
  element.textContent = ACTION_CSS
  document.head.appendChild(element)
}

/** A written page, not a checklist: a plan is a document to read, and ticks
 *  next to lines are what the task board means. Drawn inline for the same
 *  reason the diff glyph is — the primitives set ships neither. */
function PlanGlyph() {
  return (
    <svg
      className="dsh-claude-header-plan-glyph"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* Sheet with a turned corner: the outline and the fold are one path so
          the corner reads as folded rather than as a notch with a stray line. */}
      <path d="M10.5 2.25H5a1.75 1.75 0 0 0-1.75 1.75v10A1.75 1.75 0 0 0 5 15.75h8A1.75 1.75 0 0 0 14.75 14V6.5Z" />
      <path d="M10.5 2.25V6.5h4.25" />
      {/* Ragged last line: text, rather than three equal rules. */}
      <path d="M6.25 9h5.5M6.25 12h3.5" />
    </svg>
  )
}

export function ClaudePlanHeaderAction({ t, sessionId, togglePlan, planOpen, useClaudeProjection }: ClaudePlanHeaderActionProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  // One primitive, not the review object: this hook keeps a snapshot only
  // while the selected value compares equal. One linear pass over a stream
  // capped at 10k records is cheaper than a second channel publishing a flag
  // the transcript already carries.
  const key = useClaudeProjection(projection => planReviewKey(projection.activities))
  const review = parsePlanReviewKey(key)
  const open = useSyncExternalStore(planOpen.subscribe, planOpen.getSnapshot, planOpen.getSnapshot)
  // A plan arrives as something the user has to decide on right now, so the
  // panel that holds it opens itself. Once per proposal: a user who closes it
  // has closed it, and only the next plan reopens the column.
  const opened = useRef<string>()
  useEffect(() => {
    if (review?.state !== 'pending' || opened.current === review.toolUseId) return
    opened.current = review.toolUseId
    if (!open) togglePlan()
  })
  // The action row renders in every Session header. A session that never left
  // plan mode has nothing to open, so the button is absent rather than inert.
  if (!owned || review === undefined) return null
  ensureCss()
  const label = t(open ? 'planClose' : 'planOpen')
  return (
    <Tooltip label={label} side="bottom" delayMs={250}>
      <button
        type="button"
        className="dsh-claude-header-plan"
        aria-label={label}
        aria-pressed={open}
        data-pending={review.state === 'pending' || undefined}
        data-session={sessionId}
        onClick={togglePlan}
      >
        <PlanGlyph />
      </button>
    </Tooltip>
  )
}
