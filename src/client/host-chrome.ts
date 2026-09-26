/** Host chrome this plugin restyles from the browser side.
 *
 *  Every rule here reaches across into markup this package does not own, so
 *  every one is written to fail open: a Host rename makes the selector miss and
 *  the stock chrome comes back, rather than leaving the header broken.
 *
 *  Chrome this plugin wants to *change* rather than remove goes through slot
 *  shadowing where the slot's occupant is replaceable — see
 *  `ClaudeAgentPresetLabel`.
 */
import { claudeMarkUrl } from './claude-mark.ts'
import { CLAUDE_SEAT_ATTRIBUTE, trackClaudePresetSeats } from './preset-seat-mark.ts'
import { permissionSelectClass as PERMISSION_SELECT_CLASS } from './styles.ts'

/** The `Session log` capsule is contributed by
 *  `@deepseek-ai/dsh-session-log-export` into
 *  `conversation.session.header.utilities`. Shadowing that slot entry would
 *  also take its download-progress dialog down with it, so the capsule is
 *  hidden with CSS instead (Host 0.1.5 turned the capsule into an ellipsis
 *  more-actions menu whose only item is the download): the controller, its dialog, and the
 *  `/export` slash command all keep working.
 *
 *  The selector matches the CSS Module local name rather than the emitted
 *  class, because only the build-hash prefix changes across Host releases. */
const SESSION_LOG_CSS = 'button[class*="sessionLogButton"],button[class*="moreButton"][aria-haspopup="menu"]{display:none}'

/** A Claude Session has exactly one view, so its header tab strip is a row of
 *  chrome with nothing to choose between. Hiding it shortens the header, and
 *  the Host's divider — an absolutely positioned `header:after` pinned to
 *  `bottom:1px` — rides up with it on its own; only the slack the tab row used
 *  to provide has to be restored as padding.
 *
 *  Scoped through `:has()` to headers carrying this plugin's diff action, so
 *  Sessions driven by other agent presets keep their tabs. The action only
 *  mounts once the projection reports the Session as plugin-owned, so a
 *  freshly opened Session can show the strip for a frame before it collapses.
 *  Host 0.1.7 nests the strip inside the header's Slot outlet, so it is
 *  matched as a descendant rather than a direct child. */
const HEADER_TABS_CSS = [
  'header:has(.dsh-claude-header-diff) [role="tablist"]{display:none}',
  'header:has(.dsh-claude-header-diff){padding-bottom:10px}',
].join('')

/** The agent-preset seat draws `IconAgentPresetOutlineRegular` at its default 16px.
 *  Swapping it needs one fact CSS cannot read — whether the seat currently
 *  names the Claude preset — which `preset-seat-mark` supplies as an
 *  attribute. Without that flag set, nothing here matches and the Host's own
 *  glyph renders. */
const PRESET_SEAT_CSS = [
  `button[${CLAUDE_SEAT_ATTRIBUTE}]>[class*="seatIcon"]{display:none}`,
  `button[${CLAUDE_SEAT_ATTRIBUTE}]::before{content:"";flex:none;width:16px;height:16px;`,
    `background:${claudeMarkUrl()} center/contain no-repeat}`,
].join('')

/** The Host's access selector (PermissionSelect, in the composer's `modes`
 *  group) offers DSH's three sandbox modes; a Claude session runs Claude
 *  Code's own modes from this plugin's selector instead, which sits in the
 *  same tool row (`conversation.input.left`). It is hidden rather than
 *  shadowed, and only in a row where the plugin's own selector has mounted --
 *  which it does for Claude sessions alone. Host 0.1.7 renders it through the
 *  `conversation.input.permission` Slot, whose outlet carries an inline
 *  `display:contents`, so the rule needs `!important`; the `triggerLabel`
 *  local-name match stays for a Host without that outlet. */
const PERMISSION_SELECT_CSS = [
  `[class*="_tools"]:has(.${PERMISSION_SELECT_CLASS}) [data-slot="conversation.input.permission"]{display:none!important}`,
  `[class*="_tools"]:has(.${PERMISSION_SELECT_CLASS}) [class*="_modes"]>*:has(span[class*="_triggerLabel"]){display:none!important}`,
].join('')

export const HOST_CHROME_CSS = `${SESSION_LOG_CSS}${HEADER_TABS_CSS}${PRESET_SEAT_CSS}${PERMISSION_SELECT_CSS}`

/** Install the stylesheet and the one DOM flag it depends on.
 *  @returns a disposer that removes both again. */
export function restyleHostChrome(): () => void {
  if (typeof document === 'undefined') return () => {}
  const element = document.createElement('style')
  element.dataset.dshClaudeHostChrome = ''
  element.textContent = HOST_CHROME_CSS
  document.head.appendChild(element)
  const untrack = trackClaudePresetSeats()
  return () => {
    untrack()
    element.remove()
  }
}
