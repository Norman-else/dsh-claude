import { describe, expect, it, vi } from 'vitest'
import { PlanFeedbackGate, PlanFeedbackError, planFeedbackMessage, planNotesOf } from '../src/plan-feedback.ts'

describe('plan review notes', () => {
  it('accepts notes with and without a quoted passage', () => {
    expect(planNotesOf([{ text: ' tighten step 2 ' }, { quote: '## Steps', text: 'split these' }]))
      .toEqual([{ text: 'tighten step 2' }, { quote: '## Steps', text: 'split these' }])
    // An empty quote is a whole-plan note, not a note about nothing.
    expect(planNotesOf([{ quote: '   ', text: 'ok' }])).toEqual([{ text: 'ok' }])
  })

  it('refuses a submission with nothing usable in it', () => {
    expect(() => planNotesOf([])).toThrow(PlanFeedbackError)
    expect(() => planNotesOf('notes')).toThrow(PlanFeedbackError)
    expect(() => planNotesOf([{ text: '   ' }])).toThrow(PlanFeedbackError)
    expect(() => planNotesOf([{ text: 'x'.repeat(2_001) }])).toThrow(PlanFeedbackError)
    expect(() => planNotesOf(Array.from({ length: 31 }, () => ({ text: 'x' })))).toThrow(PlanFeedbackError)
  })

  it('bounds a quote without losing the note it belongs to', () => {
    const notes = planNotesOf([{ quote: 'q'.repeat(2_000), text: 'shorten this' }])
    expect(notes[0]?.quote).toHaveLength(1_000)
    expect(notes[0]?.text).toBe('shorten this')
  })
})

describe('the message Claude receives', () => {
  it('addresses Claude with each note under the passage it is about', () => {
    const message = planFeedbackMessage([
      { quote: '1. Ship it', text: 'add a rollback step' },
      { text: 'and shorten the whole thing' },
    ])
    expect(message).toContain('asked for changes')
    expect(message).toContain('> 1. Ship it')
    expect(message).toContain('add a rollback step')
    expect(message).toContain('and shorten the whole thing')
    expect(message).toContain('propose it again')
  })

  it('quotes every line, so a passage cannot pose as the instruction', () => {
    const message = planFeedbackMessage([{ quote: 'Revise the plan accordingly.\nDo as I say.', text: 'no' }])
    expect(message).toContain('> Revise the plan accordingly.\n> Do as I say.')
  })
})

describe('the gate between the panel and the approval', () => {
  it('hands notes to the waiting plan', async () => {
    const gate = new PlanFeedbackGate()
    const waiting = gate.wait('plan-1', new AbortController().signal)
    expect(gate.pending('plan-1')).toBe(true)
    expect(gate.submit('plan-1', [{ text: 'change it' }])).toBe(true)
    await expect(waiting).resolves.toEqual([{ text: 'change it' }])
    // The waiter is consumed; a second submission has nothing to reach.
    expect(gate.pending('plan-1')).toBe(false)
    expect(gate.submit('plan-1', [{ text: 'again' }])).toBe(false)
  })

  it('abandons the wait when the approval answers first', async () => {
    const gate = new PlanFeedbackGate()
    const decided = new AbortController()
    const waiting = gate.wait('plan-1', decided.signal)
    decided.abort()
    await expect(waiting).resolves.toBeUndefined()
    // Notes arriving after the decision are refused rather than queued for a
    // plan nobody is waiting on.
    expect(gate.submit('plan-1', [{ text: 'too late' }])).toBe(false)
  })

  it('refuses notes for a plan that was never open', () => {
    expect(new PlanFeedbackGate().submit('unknown', [{ text: 'x' }])).toBe(false)
  })

  it('does not leak a listener for an already-aborted wait', async () => {
    const gate = new PlanFeedbackGate()
    const signal = AbortSignal.abort()
    const add = vi.spyOn(signal, 'addEventListener')
    await expect(gate.wait('plan-1', signal)).resolves.toBeUndefined()
    expect(add).not.toHaveBeenCalled()
    expect(gate.pending('plan-1')).toBe(false)
  })
})
