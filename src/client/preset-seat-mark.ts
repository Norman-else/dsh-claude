import { CLAUDE_PRESET_DESCRIPTION } from '../constants.ts'
import { isClaudePresetText } from './hero-dom-bridge.ts'
import { en, zh } from './locales.ts'

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

/** Every spelling the Claude preset's description can currently have in the
 *  tree: the published English, or a translation this bridge already wrote
 *  before the locale changed. */
const DESCRIPTION_VARIANTS = new Set([CLAUDE_PRESET_DESCRIPTION, en.presetClaudeDescription, zh.presetClaudeDescription])

/**
 * Translate the Claude preset's description where the Host's preset menu
 * renders it. The Host resolves only its own presets' copy through the locale
 * dictionaries and prints a third-party preset's metadata verbatim, and no
 * public hook reaches that menu, so the text node itself is rewritten. It
 * fails open: a Host that renders the copy differently keeps the English.
 * @param root - subtree to sweep.
 * @param text - the description in the active locale.
 */
export function localizeClaudePresetDescription(root: ParentNode, text: string): void {
  for (const menu of root.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"]')) {
    const walker = menu.ownerDocument.createTreeWalker(menu, 4 /* NodeFilter.SHOW_TEXT */)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const value = node.nodeValue ?? ''
      const trimmed = value.trim()
      if (trimmed === text || !DESCRIPTION_VARIANTS.has(trimmed)) continue
      node.nodeValue = value.replace(trimmed, text)
    }
  }
}

/** Keep the flag, and the translated description, in step with the Host's
 *  own re-renders.
 *  @param description - the Claude preset description in the active locale.
 *  @returns a disposer that stops observing and clears every flag it set. */
export function trackClaudePresetSeats(description?: () => string): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let frame: number | undefined
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(() => {
      frame = undefined
      markClaudePresetSeats(document)
      // Idempotent: a node already carrying the text is skipped, so the
      // character-data record this write produces settles on the next frame.
      if (description !== undefined) localizeClaudePresetDescription(document, description())
    })
  }
  // Attributes are deliberately not observed: this bridge writes one, and
  // observing them would make it re-enter on its own mutations.
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  markClaudePresetSeats(document)
  if (description !== undefined) localizeClaudePresetDescription(document, description())
  return () => {
    observer.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    for (const seat of document.querySelectorAll(`[${CLAUDE_SEAT_ATTRIBUTE}]`)) seat.removeAttribute(CLAUDE_SEAT_ATTRIBUTE)
  }
}
