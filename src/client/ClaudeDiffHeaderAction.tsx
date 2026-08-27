import { useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeClientProjection } from './projection.ts'
import type { DiffOpenSource } from './diff-open-store.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'

export interface ClaudeDiffHeaderActionInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Toggle this session's diff panel in the details column. */
  toggleDiff: () => void
  /** Whether that panel is currently on screen for this session. */
  diffOpen: DiffOpenSource
}

export interface ClaudeDiffHeaderActionProps extends ClaudeDiffHeaderActionInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  sessionId: string
}

/** Quiet by default, lit on hover, press, keyboard focus, and for as long as
 *  the panel it opened is on screen. The header action row sits on the app
 *  background, so a resting background would read as a filled control. */
const ACTION_CSS = [
  '.dsh-claude-header-diff{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;',
    'min-width:32px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;',
    'color:var(--dsw-alias-label-secondary);cursor:pointer;',
    'font-family:var(--dsw-font-family);font-size:12px;line-height:20px;font-weight:650;',
    'transition:background .12s ease,color .12s ease}',
  // Counts turn the square into a capsule; the glyph keeps its optical inset.
  '.dsh-claude-header-diff[data-counts]{padding:0 10px 0 8px}',
  '.dsh-claude-header-diff:hover,.dsh-claude-header-diff:focus-visible,.dsh-claude-header-diff[aria-pressed="true"]{',
    'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-header-diff:active{background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-claude-header-diff:focus-visible{outline:none}',
  // Nothing in the capsule may shrink, and the glyph's geometry lives here
  // rather than on the element: SVG presentation attributes lose to any CSS
  // rule an ancestor happens to carry, so `width`/`stroke` written only as
  // attributes are one stray App rule away from a blank button.
  '.dsh-claude-header-diff>*{flex:none}',
  '.dsh-claude-header-diff>svg.dsh-claude-header-diff-glyph{',
    'width:18px;height:18px;display:block;overflow:visible;opacity:1;',
    'fill:none;stroke:currentColor;stroke-width:2.1;stroke-linecap:round}',
  // The inherited 20px line box centres on the digits' descender space rather
  // than on the digits, which reads as the counts riding high next to the
  // glyph. A tight box tracks the ink instead.
  '.dsh-claude-header-diff-add,.dsh-claude-header-diff-del{line-height:1}',
  '.dsh-claude-header-diff-add{color:var(--dsw-alias-state-success-primary)}',
  '.dsh-claude-header-diff-del{color:var(--dsw-alias-state-error-primary)}',
].join('')

let cssInjected = false
function ensureCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const element = document.createElement('style')
  element.dataset.dshClaudeHeaderDiff = ''
  element.textContent = ACTION_CSS
  document.head.appendChild(element)
}

/** Plus over minus: the diff glyph. Drawn inline because the primitives icon
 *  set ships no diff icon.
 *
 *  The ink spans y 3.5 to 14.5 — symmetric about the box's own centre line, so
 *  `align-items:center` lands the drawn shape on the centre rather than the
 *  bounding box that happens to contain it. */
function DiffGlyph() {
  return (
    <svg
      className="dsh-claude-header-diff-glyph"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      focusable="false"
    ><path d="M9 3.5v5.5M6.25 6.25h5.5M6.25 14.5h5.5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" /></svg>
  )
}

export function ClaudeDiffHeaderAction({ t, sessionId, toggleDiff, diffOpen, useClaudeProjection }: ClaudeDiffHeaderActionProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  // Selected one primitive at a time: a composite selector would allocate a
  // fresh object per snapshot and defeat the hook's equality check.
  const additions = useClaudeProjection(projection => projection.repository?.diff?.additions ?? 0)
  const deletions = useClaudeProjection(projection => projection.repository?.diff?.deletions ?? 0)
  const open = useSyncExternalStore(diffOpen.subscribe, diffOpen.getSnapshot, diffOpen.getSnapshot)
  // The action row renders in every Session header, including ones driven by
  // other agent presets; only Claude sessions have a diff to show.
  if (!owned) return null
  ensureCss()
  // An all-zero diff reads as noise next to the glyph, so the counts appear
  // only once the branch actually carries changes.
  const hasCounts = additions > 0 || deletions > 0
  // A toggle names its effect, not its target: the pressed state already says
  // the panel is open, so the label says what the next press does.
  const label = t(open ? 'diffClose' : 'diffOpen')
  // The DSH bubble, not the native `title` popup: the browser's own tooltip
  // ignores the app's theme and its delay is not ours to set.
  return (
    <Tooltip label={label} side="bottom" delayMs={250}>
      <button
        type="button"
        className="dsh-claude-header-diff"
        aria-label={label}
        aria-pressed={open}
        data-counts={hasCounts || undefined}
        data-session={sessionId}
        onClick={toggleDiff}
      >
        <DiffGlyph />
        {hasCounts ? <>
          <span className="dsh-claude-header-diff-add">+{additions}</span>
          <span className="dsh-claude-header-diff-del">−{deletions}</span>
        </> : null}
      </button>
    </Tooltip>
  )
}
