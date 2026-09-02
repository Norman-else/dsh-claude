import { describe, expect, it } from 'vitest'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { latestPlanReview, parsePlanReviewKey, planReviewKey, planReviews, planTitle, quotedSelection } from '../src/client/ClaudePlanPanel.tsx'

let ordinal = 0
function permission(fields: Partial<ClaudeActivityEvent>): ClaudeActivityEvent {
  ordinal += 1
  return { turn: 1, step: 0, ordinal, kind: 'permission', toolName: 'ExitPlanMode', ...fields }
}

describe('plan panel review selection', () => {
  it('reads the plan off the permission record that carries it', () => {
    const review = latestPlanReview([
      permission({ phase: 'started', toolUseId: 'plan-1', text: '## Steps\n\n1. Ship' }),
    ])
    expect(review).toEqual({ toolUseId: 'plan-1', plan: '## Steps\n\n1. Ship', state: 'pending' })
  })

  it('settles on the decision recorded under the same tool use', () => {
    const proposal = permission({ phase: 'started', toolUseId: 'plan-1', text: '# Plan' })
    const approved = latestPlanReview([proposal, permission({ phase: 'completed', toolUseId: 'plan-1' })])
    expect(approved?.state).toBe('approved')
    const rejected = latestPlanReview([proposal, permission({ phase: 'denied', toolUseId: 'plan-1' })])
    expect(rejected?.state).toBe('rejected')
    // A failed approval never reached the user, and Claude was told no.
    const failed = latestPlanReview([proposal, permission({ phase: 'failed', toolUseId: 'plan-1' })])
    expect(failed?.state).toBe('rejected')
    // Another tool's decision is not this plan's.
    const unrelated = latestPlanReview([proposal, permission({ phase: 'completed', toolUseId: 'bash-9', toolName: 'Bash' })])
    expect(unrelated?.state).toBe('pending')
  })

  it('shows the newest plan, so a re-proposal replaces the one it answers', () => {
    const review = latestPlanReview([
      permission({ phase: 'started', toolUseId: 'plan-1', text: 'first' }),
      permission({ phase: 'denied', toolUseId: 'plan-1' }),
      permission({ phase: 'started', toolUseId: 'plan-2', text: 'second' }),
    ])
    // The rejection belongs to the plan it rejected, not to the new one.
    expect(review).toEqual({ toolUseId: 'plan-2', plan: 'second', state: 'pending' })
  })

  it('ignores everything that is not a plan handed over for approval', () => {
    expect(latestPlanReview([])).toBeUndefined()
    expect(latestPlanReview([permission({ phase: 'started', toolUseId: 'bash-1', toolName: 'Bash', text: 'rm -rf /' })])).toBeUndefined()
    // A plan approval with no plan on it is nothing to render.
    expect(latestPlanReview([permission({ phase: 'started', toolUseId: 'plan-1' })])).toBeUndefined()
    expect(latestPlanReview([permission({ phase: 'started', toolUseId: 'plan-1', text: '' })])).toBeUndefined()
    // Prose in the transcript is not a plan, whatever it says.
    expect(latestPlanReview([{ turn: 1, step: 0, ordinal: 1, kind: 'text', text: '# Plan' }])).toBeUndefined()
  })
})

describe('plan review key', () => {
  const proposal = permission({ phase: 'started', toolUseId: 'plan-1', text: '# Plan' })

  it('round-trips through the primitive the header action selects on', () => {
    const key = planReviewKey([proposal])
    expect(parsePlanReviewKey(key)).toEqual({ state: 'pending', toolUseId: 'plan-1' })
    // The key moves when the decision lands, which is what reopens nothing and
    // repaints the dot.
    expect(planReviewKey([proposal, permission({ phase: 'completed', toolUseId: 'plan-1' })])).not.toBe(key)
  })

  it('survives a tool use id that contains the separator', () => {
    const odd = permission({ phase: 'started', toolUseId: 'toolu:01:abc', text: '# Plan' })
    expect(parsePlanReviewKey(planReviewKey([odd]))).toEqual({ state: 'pending', toolUseId: 'toolu:01:abc' })
  })

  it('reads no plan as no key', () => {
    expect(planReviewKey([])).toBe('')
    expect(parsePlanReviewKey('')).toBeUndefined()
    expect(parsePlanReviewKey('nonsense:plan-1')).toBeUndefined()
  })
})

describe('every plan in a session', () => {
  it('keeps each proposal with its own decision, oldest first', () => {
    const reviews = planReviews([
      permission({ phase: 'started', toolUseId: 'plan-1', text: '# First' }),
      permission({ phase: 'denied', toolUseId: 'plan-1' }),
      permission({ phase: 'started', toolUseId: 'plan-2', text: '# Second' }),
      permission({ phase: 'completed', toolUseId: 'plan-2' }),
      permission({ phase: 'started', toolUseId: 'plan-3', text: '# Third' }),
    ])
    expect(reviews).toEqual([
      { toolUseId: 'plan-1', plan: '# First', state: 'rejected' },
      { toolUseId: 'plan-2', plan: '# Second', state: 'approved' },
      { toolUseId: 'plan-3', plan: '# Third', state: 'pending' },
    ])
    // The panel's default and the header dot both read the newest.
    expect(latestPlanReview([
      permission({ phase: 'started', toolUseId: 'plan-1', text: '# First' }),
      permission({ phase: 'started', toolUseId: 'plan-2', text: '# Second' }),
    ])?.toolUseId).toBe('plan-2')
  })

  it('does not let another tool\'s decision settle a plan', () => {
    const reviews = planReviews([
      permission({ phase: 'started', toolUseId: 'plan-1', text: '# Plan' }),
      permission({ phase: 'completed', toolUseId: 'bash-1', toolName: 'Bash' }),
    ])
    expect(reviews).toEqual([{ toolUseId: 'plan-1', plan: '# Plan', state: 'pending' }])
  })

  it('reads no plans as an empty list', () => {
    expect(planReviews([])).toEqual([])
    expect(planReviews([permission({ phase: 'started', toolUseId: 'bash-1', toolName: 'Bash', text: 'ls' })])).toEqual([])
  })
})

describe('plan titles', () => {
  it('names a plan by its first heading', () => {
    expect(planTitle('# 模拟 Plan：给面板加大纲\n\nbody')).toBe('模拟 Plan：给面板加大纲')
    expect(planTitle('\n\n## Second level\n')).toBe('Second level')
    // Closing hashes are decoration, not part of the name.
    expect(planTitle('### Trimmed ###')).toBe('Trimmed')
  })

  it('falls back to the opening line when a plan has no heading', () => {
    expect(planTitle('Just a sentence.\n# Later heading')).toBe('Just a sentence.')
    expect(planTitle('')).toBe('')
    expect(planTitle('   \n  \n')).toBe('')
  })

  it('bounds a title that would push the picker wide', () => {
    expect(planTitle(`# ${'long '.repeat(40)}`).length).toBeLessThanOrEqual(80)
  })
})

describe('quoting a passage of the plan', () => {
  const body = { contains: (node: Node) => node !== outside } as unknown as Node
  const outside = {} as Node
  const inside = {} as Node
  const selection = (fields: Partial<Selection> & { text?: string }): Selection => ({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({ startContainer: inside, endContainer: inside }) as Range,
    toString: () => fields.text ?? '',
    ...fields,
  }) as unknown as Selection

  it('quotes a selection that lies inside the plan body', () => {
    expect(quotedSelection(selection({ text: '  1. Ship it  ' }), body)).toBe('1. Ship it')
  })

  it('ignores a selection that is not the reader marking up the plan', () => {
    expect(quotedSelection(null, body)).toBeUndefined()
    expect(quotedSelection(selection({ text: 'x' }), null)).toBeUndefined()
    expect(quotedSelection(selection({ text: 'x', isCollapsed: true }), body)).toBeUndefined()
    expect(quotedSelection(selection({ text: 'x', rangeCount: 0 }), body)).toBeUndefined()
    // Whitespace is not a passage.
    expect(quotedSelection(selection({ text: '   \n ' }), body)).toBeUndefined()
  })

  it('ignores a selection that starts or ends outside the plan', () => {
    const straddling = selection({
      text: 'half of this is the transcript',
      getRangeAt: () => ({ startContainer: outside, endContainer: inside }) as Range,
    })
    expect(quotedSelection(straddling, body)).toBeUndefined()
  })

  it('bounds a selection of the whole plan', () => {
    expect(quotedSelection(selection({ text: 'q'.repeat(4_000) }), body)).toHaveLength(1_000)
  })
})
