const PORTAL_ATTRIBUTE = 'data-dsh-claude-hero-controls'
const HERO_SELECTOR = '[data-phase="hero"]'

function normalizedText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

export function isClaudePresetText(value: string): boolean {
  return /^claude(?: code)?$/iu.test(value.replace(/\s+/gu, ' ').trim())
}

function directChildContaining(parent: Element, descendant: Element): Element | undefined {
  return Array.from(parent.children).find(child => child === descendant || child.contains(descendant))
}

/** The hero's preset buttons: menu buttons without an `aria-label`, which is
 *  what separates the preset seat from the labelled workspace picker. */
function heroPresetButtons(root: ParentNode): { hero: HTMLElement; presets: HTMLButtonElement[] } | undefined {
  const heroes = Array.from(root.querySelectorAll<HTMLElement>(HERO_SELECTOR))
  if (heroes.length !== 1) return undefined
  const hero = heroes[0]
  if (hero === undefined) return undefined
  const menuButtons = Array.from(hero.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]'))
  return { hero, presets: menuButtons.filter(button => button.getAttribute('aria-label') === null) }
}

/** True once the hero has settled on a preset that is not Claude.
 *  `locateClaudePresetSeat` reports that the same way it reports a hero
 *  mid-render -- by missing -- so without this the retention rule below reads a
 *  deliberate switch away from Claude as a re-render and leaves the controls up. */
export function showsOtherPresetSeat(root: ParentNode = document): boolean {
  const found = heroPresetButtons(root)
  if (found === undefined || found.presets.length !== 1) return false
  const preset = found.presets[0]
  return preset !== undefined && !isClaudePresetText(normalizedText(preset))
}

/** Locate rc.8's hero preset seat without relying on hashed CSS module names. */
export function locateClaudePresetSeat(root: ParentNode = document): { hero: HTMLElement; seat: Element } | undefined {
  const found = heroPresetButtons(root)
  if (found === undefined) return undefined
  const { hero } = found
  const presetButtons = found.presets.filter(button => isClaudePresetText(normalizedText(button)))
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

/** Keep a portal the host has not torn down. `locateClaudePresetSeat` also
 *  misses while a hero re-renders -- a second hero mid session switch, a preset
 *  label swap -- and dropping the portal there recreates it a beat later with a
 *  fresh identity, which restarts every effect keyed on it and strands the
 *  branch picker on "Loading branches". A portal whose hero flipped phase or
 *  unmounted has left the DOM (or left the hero) and is not retained. */
export function retainsClaudeHeroPortal(portal: { closest: (selector: string) => unknown } | undefined): boolean {
  const hero = portal?.closest(HERO_SELECTOR)
  return hero !== null && hero !== undefined
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
