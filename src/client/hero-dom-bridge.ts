const PORTAL_ATTRIBUTE = 'data-dsh-claude-hero-controls'

function normalizedText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

export function isClaudePresetText(value: string): boolean {
  return /^claude(?: code)?$/iu.test(value.replace(/\s+/gu, ' ').trim())
}

function directChildContaining(parent: Element, descendant: Element): Element | undefined {
  return Array.from(parent.children).find(child => child === descendant || child.contains(descendant))
}

/** Locate rc.8's hero preset seat without relying on hashed CSS module names. */
export function locateClaudePresetSeat(root: ParentNode = document): { hero: HTMLElement; seat: Element } | undefined {
  const heroes = Array.from(root.querySelectorAll<HTMLElement>('[data-phase="hero"]'))
  if (heroes.length !== 1) return undefined
  const hero = heroes[0]
  if (hero === undefined) return undefined
  const menuButtons = Array.from(hero.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]'))
  const presetButtons = menuButtons.filter(button => button.getAttribute('aria-label') === null && isClaudePresetText(normalizedText(button)))
  if (presetButtons.length !== 1) return undefined
  const preset = presetButtons[0]
  if (preset === undefined) return undefined
  let row: Element | null = preset.parentElement
  while (row !== null && row !== hero) {
    const workspace = Array.from(row.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"][aria-label]'))
    if (workspace.length === 1) {
      const seat = directChildContaining(row, preset)
      if (seat !== undefined) return { hero, seat }
    }
    row = row.parentElement
  }
  return undefined
}

/** Reuse the row's existing portal even when the host moved a node between it
 *  and the seat: a fresh element would change React's portal identity and
 *  restart (and abort) every effect keyed on it. */
export function ensureClaudeHeroPortal(seat: Element): HTMLElement {
  const existing = seat.parentElement?.querySelector<HTMLElement>(`:scope > [${PORTAL_ATTRIBUTE}]`) ?? null
  if (existing !== null) {
    if (existing.previousElementSibling !== seat) seat.insertAdjacentElement('afterend', existing)
    return existing
  }
  const portal = document.createElement('span')
  portal.setAttribute(PORTAL_ATTRIBUTE, '')
  seat.insertAdjacentElement('afterend', portal)
  return portal
}

export function removeClaudeHeroPortals(root: ParentNode = document): void {
  for (const portal of root.querySelectorAll<HTMLElement>(`[${PORTAL_ATTRIBUTE}]`)) portal.remove()
}
