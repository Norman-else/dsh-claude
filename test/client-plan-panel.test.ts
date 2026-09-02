import { describe, expect, it } from 'vitest'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { latestPlanReview } from '../src/client/ClaudePlanPanel.tsx'

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
    expect(review).toEqual({ toolUseId: 'plan-1', plan: '## Steps\n\n1. Ship', turn: 1, state: 'pending' })
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
      permission({ phase: 'started', toolUseId: 'plan-2', text: 'second', turn: 2 }),
    ])
    // The rejection belongs to the plan it rejected, not to the new one.
    expect(review).toEqual({ toolUseId: 'plan-2', plan: 'second', turn: 2, state: 'pending' })
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
