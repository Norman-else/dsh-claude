/** Seats for the rewind control inside the Host's own message action rows.
 *
 *  The chat exposes an additive slot for assistant actions only, so a control
 *  on a USER message has to reach into markup this package does not own. Every
 *  lookup here fails open: a Host rename makes the selector miss and the row
 *  keeps its stock copy/branch actions instead of breaking. */

const PORTAL_ATTRIBUTE = 'data-dsh-claude-rewind'
/** The chat row wrapper carries the node kind and its stable node key. */
const USER_ROW = '[data-chat-flow-kind="user"][data-chat-flow-key]'
/** MessageIconActions composes its own CSS-module class onto the row; only the
 *  build-hash prefix changes across Host releases. */
const ACTIONS_ROW = '[class*="actions"]'

export interface ClaudeRewindSeat {
  /** Chat node key of the user message this seat belongs to. */
  readonly key: string
  /** Portal host, mounted immediately left of the copy action. */
  readonly host: HTMLElement
}

/** Reuse an existing seat rather than minting a fresh element: a new node would
 *  change React's portal identity and restart every effect keyed on it. */
function ensureSeat(row: HTMLElement): HTMLElement | undefined {
  const actions = row.querySelector<HTMLElement>(ACTIONS_ROW)
  if (actions === null) return undefined
  const existing = actions.querySelector<HTMLElement>(`:scope > [${PORTAL_ATTRIBUTE}]`)
  const copy = actions.querySelector<HTMLElement>(':scope > button')
  if (existing !== null) {
    if (copy !== null && existing.nextElementSibling !== copy) actions.insertBefore(existing, copy)
    return existing
  }
  const seat = document.createElement('span')
  seat.setAttribute(PORTAL_ATTRIBUTE, '')
  seat.style.display = 'inline-flex'
  if (copy === null) actions.appendChild(seat)
  else actions.insertBefore(seat, copy)
  return seat
}

/** Every visible user message row, paired with its portal host. */
export function locateClaudeRewindSeats(root: ParentNode = document): ClaudeRewindSeat[] {
  const seats: ClaudeRewindSeat[] = []
  for (const row of root.querySelectorAll<HTMLElement>(USER_ROW)) {
    const key = row.getAttribute('data-chat-flow-key')
    if (key === null || key.length === 0) continue
    const host = ensureSeat(row)
    if (host !== undefined) seats.push({ key, host })
  }
  return seats
}

export function removeClaudeRewindSeats(root: ParentNode = document): void {
  for (const seat of root.querySelectorAll<HTMLElement>(`[${PORTAL_ATTRIBUTE}]`)) seat.remove()
}

export function sameClaudeRewindSeats(left: readonly ClaudeRewindSeat[], right: readonly ClaudeRewindSeat[]): boolean {
  return left.length === right.length
    && left.every((seat, index) => seat.key === right[index]?.key && seat.host === right[index]?.host)
}

/** Hide every rewound row: the DSH session log is append-only, so the rows the
 *  rewind dropped stay in the transcript and are suppressed here. A turn's
 *  steps also sit in a process group seat whose key is synthetic, not any
 *  node's; a rewind drops whole turns, so those seats are hidden by turn. */
export function rewindHiddenCss(keys: readonly string[], turns: readonly number[] = []): string {
  const selectors = [
    ...keys
      .filter(key => !key.includes('"') && !key.includes('\\'))
      .map(key => `[data-chat-flow-key="${key}"]`),
    ...turns.filter(Number.isSafeInteger).map(turn => `[data-chat-group-key][data-chat-turn="${turn}"]`),
  ]
  return selectors.length === 0 ? '' : `${selectors.join(',')}{display:none}`
}

/** The log seq a chat node stands for. The Host seats a turn's process row
 *  ("Analysis completed") a tenth before its turn/start, so by its raw anchor
 *  it would escape a rewind range that begins at that turn/start. */
export function rewindNodeSeq(kind: string, anchorSeq: number): number {
  return kind === 'turn-process' ? Math.ceil(anchorSeq) : anchorSeq
}
