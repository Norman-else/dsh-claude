import { useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeClientProjection } from './projection.ts'
import type { PanelOpenSource } from './panel-open-store.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { latestPlanReview } from './ClaudePlanPanel.tsx'

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

/** A checklist: the plan is a document of steps. Drawn inline for the same
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
      <path d="m2.75 5.25 1.4 1.4 2.35-2.6M2.75 12.25l1.4 1.4 2.35-2.6" />
      <path d="M9.25 5.25h6M9.25 12.25h6" />
    </svg>
  )
}

export function ClaudePlanHeaderAction({ t, sessionId, togglePlan, planOpen, useClaudeProjection }: ClaudePlanHeaderActionProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  // The state string, not the review object: this hook keeps a snapshot only
  // while the selected value compares equal, and a fresh object per snapshot
  // would defeat that. One linear pass over a stream capped at 10k records is
  // cheaper than a second channel publishing a flag the transcript carries.
  const state = useClaudeProjection(projection => latestPlanReview(projection.activities)?.state)
  const open = useSyncExternalStore(planOpen.subscribe, planOpen.getSnapshot, planOpen.getSnapshot)
  // The action row renders in every Session header. A session that never left
  // plan mode has nothing to open, so the button is absent rather than inert.
  if (!owned || state === undefined) return null
  ensureCss()
  const label = t(open ? 'planClose' : 'planOpen')
  return (
    <Tooltip label={label} side="bottom" delayMs={250}>
      <button
        type="button"
        className="dsh-claude-header-plan"
        aria-label={label}
        aria-pressed={open}
        data-pending={state === 'pending' || undefined}
        data-session={sessionId}
        onClick={togglePlan}
      >
        <PlanGlyph />
      </button>
    </Tooltip>
  )
}
