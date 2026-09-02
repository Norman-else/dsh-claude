/** One note the reviewer left on a plan: what they said, and the passage they
 *  said it about. */
export interface PlanNote {
  /** The exact passage the note is anchored to, absent for a whole-plan note. */
  readonly quote?: string
  readonly text: string
}

const MAX_NOTES = 30
const MAX_NOTE_CHARS = 2_000
const MAX_QUOTE_CHARS = 1_000

export class PlanFeedbackError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PlanFeedbackError'
    this.code = code
  }
}

/** Validate and bound one submission's notes. */
export function planNotesOf(value: unknown): readonly PlanNote[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NOTES) {
    throw new PlanFeedbackError('invalid-request', 'The review notes are invalid.')
  }
  return value.map(item => {
    const note = item !== null && typeof item === 'object' ? item as Record<string, unknown> : undefined
    const text = typeof note?.text === 'string' ? note.text.trim() : ''
    if (text.length === 0 || text.length > MAX_NOTE_CHARS) {
      throw new PlanFeedbackError('invalid-request', 'A review note is empty or too long.')
    }
    const quote = typeof note?.quote === 'string' ? note.quote.trim().slice(0, MAX_QUOTE_CHARS) : ''
    return quote.length === 0 ? { text } : { quote, text }
  })
}

/** What Claude is told when the reviewer asks for changes.
 *
 *  Addressed to Claude rather than logged at it: a rejection it cannot act on
 *  is the thing this whole path exists to replace. The quotes are fenced as
 *  block quotes so a passage containing its own Markdown cannot be mistaken
 *  for the reviewer's instruction. */
export function planFeedbackMessage(notes: readonly PlanNote[]): string {
  const body = notes.map(note => note.quote === undefined
    ? note.text
    : `On this part of the plan:\n${note.quote.split('\n').map(line => `> ${line}`).join('\n')}\n\n${note.text}`)
  return [
    'The user reviewed the plan in DeepSeek Harness and asked for changes rather than approving or rejecting it.',
    '',
    body.join('\n\n---\n\n'),
    '',
    'Revise the plan accordingly and propose it again.',
  ].join('\n')
}

/** The seam between the panel's "send for changes" and the permission bridge
 *  waiting on that plan's approval.
 *
 *  The approval promise lives inside the bridge and cannot be resolved from
 *  outside, so the bridge races it against this gate instead: whichever
 *  answers first decides, and the loser is aborted. One waiter per tool use —
 *  a plan is approved once. */
export class PlanFeedbackGate {
  readonly #waiting = new Map<string, (notes: readonly PlanNote[]) => void>()

  /** Notes for the plan under `toolUseId`, or undefined when the wait is
   *  abandoned because the approval surface answered first. */
  wait(toolUseId: string, signal: AbortSignal): Promise<readonly PlanNote[] | undefined> {
    return new Promise(resolve => {
      const settle = (notes: readonly PlanNote[] | undefined): void => {
        if (this.#waiting.get(toolUseId) === deliver) this.#waiting.delete(toolUseId)
        signal.removeEventListener('abort', onAbort)
        resolve(notes)
      }
      const deliver = (notes: readonly PlanNote[]): void => { settle(notes) }
      const onAbort = (): void => { settle(undefined) }
      if (signal.aborted) {
        resolve(undefined)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#waiting.set(toolUseId, deliver)
    })
  }

  /** Hand notes to a waiting plan approval. False when nothing is waiting —
   *  the plan was already decided, or never existed. */
  submit(toolUseId: string, notes: readonly PlanNote[]): boolean {
    const deliver = this.#waiting.get(toolUseId)
    if (deliver === undefined) return false
    deliver(notes)
    return true
  }

  /** Whether a plan is currently open for review. */
  pending(toolUseId: string): boolean {
    return this.#waiting.has(toolUseId)
  }
}
