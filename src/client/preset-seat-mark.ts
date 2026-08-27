import { isClaudePresetText } from './hero-dom-bridge.ts'

/** Flags the Host's agent-preset seat while it names the Claude preset.
 *
 *  The seat is a `single` slot whose occupant owns the whole picker — menu,
 *  staging, the intro animation. Shadowing it to change one glyph would mean
 *  reimplementing all of that, so the glyph is swapped in CSS instead. CSS
 *  cannot read the seat's text, though, and the seat names whichever preset is
 *  currently staged, so the brand mark would otherwise land on `standard` or
 *  `cordis` too. This bridge supplies the one bit CSS is missing.
 *
 *  Keyed on the seat icon's CSS Module local name plus `aria-haspopup`, both of
 *  which fail open: a Host rename leaves the attribute unset and the stock
 *  glyph in place.
 */

/** Attribute the stylesheet keys the mark swap off. */
export const CLAUDE_SEAT_ATTRIBUTE = 'data-dsh-claude-preset'

const SEAT_SELECTOR = 'button[aria-haspopup="menu"]'
const SEAT_ICON_SELECTOR = '[class*="seatIcon"]'

/**
 * Set or clear the flag on every preset seat currently in the tree.
 * @param root - subtree to sweep; the document by default.
 */
export function markClaudePresetSeats(root: ParentNode): void {
  for (const icon of root.querySelectorAll(SEAT_ICON_SELECTOR)) {
    const seat = icon.closest(SEAT_SELECTOR)
    if (seat === null) continue
    // The intro animation splits the name into per-character spans, so read
    // the accumulated text rather than a single label node.
    if (isClaudePresetText(seat.textContent ?? '')) seat.setAttribute(CLAUDE_SEAT_ATTRIBUTE, '')
    else seat.removeAttribute(CLAUDE_SEAT_ATTRIBUTE)
  }
}

/** Keep the flag in step with the Host's own re-renders.
 *  @returns a disposer that stops observing and clears every flag it set. */
export function trackClaudePresetSeats(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let frame: number | undefined
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(() => {
      frame = undefined
      markClaudePresetSeats(document)
    })
  }
  // Attributes are deliberately not observed: this bridge writes one, and
  // observing them would make it re-enter on its own mutations.
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  markClaudePresetSeats(document)
  return () => {
    observer.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    for (const seat of document.querySelectorAll(`[${CLAUDE_SEAT_ATTRIBUTE}]`)) seat.removeAttribute(CLAUDE_SEAT_ATTRIBUTE)
  }
}
