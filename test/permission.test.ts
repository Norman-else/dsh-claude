import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createPermissionBridge, mapApprovalOutcome, permissionReason, planText } from '../src/permission.ts'
import { normalizeActivity } from '../src/events.ts'

function active() {
  const events: Array<{ type: string; data: unknown }> = []
  const agent = {} as Agent
  return {
    agent,
    cursor: { turn: 1, step: 1, nextOrdinal: 0 },
    events,
    appendActivity: async (data: unknown) => { events.push({ type: 'activity', data }) },
  }
}

const toolOptions = (signal = new AbortController().signal) => ({
  signal,
  toolUseID: 'tool-1',
  requestId: 'request-1',
  title: 'Claude wants to edit a file',
})

describe('permission result mapping', () => {
  it('grants only allowed-once with unchanged input', () => {
    const input = { file: 'a.txt' }
    expect(mapApprovalOutcome('allowed-once', input, 'tool-1')).toMatchObject({
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: 'user_temporary',
    })
    for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
      expect(mapApprovalOutcome(outcome, input, 'tool-1').behavior).toBe('deny')
    }
  })

  it('redacts secrets from approval reasons', () => {
    const reason = permissionReason('Bash', { command: 'echo ok', api_key: 'nope' }, toolOptions())
    expect(reason).toContain('echo ok')
    expect(reason).toContain('[REDACTED]')
    expect(reason).not.toContain('nope')
  })

  it('points the approval dialog at the plan panel instead of pasting the plan', () => {
    const plan = `## Plan\n\n1. Read ${'the supervisor '.repeat(200)}\n2. Ship it`
    const reason = permissionReason('ExitPlanMode', { plan }, toolOptions())
    // The dialog renders its reason as plain text in a cramped modal, so it
    // says what is being decided and where to read it; the plan itself goes to
    // the panel that can render Markdown.
    expect(reason).toContain('Plan panel')
    expect(reason).not.toContain('the supervisor')
    expect(reason).not.toContain('Input: ')
    // An empty or missing plan falls back to the ordinary prompt.
    expect(permissionReason('ExitPlanMode', { plan: '' }, toolOptions())).toContain('Input: ')
  })

  it('carries the plan on the activity field wide enough to hold it', () => {
    // `summary` caps at 1k and `detail` at 4k; only `text` (64k) survives a
    // real plan intact.
    const plan = `## Plan\n\n${'step '.repeat(2_000)}`
    expect(plan.length).toBeGreaterThan(4_000)
    expect(planText('ExitPlanMode', { plan })).toBe(plan)
    expect(normalizeActivity({ turn: 1, step: 0, ordinal: 0, kind: 'permission', text: plan }).text).toBe(plan)
    // Nothing else routes through the plan panel.
    expect(planText('Bash', { plan })).toBeUndefined()
    expect(planText('ExitPlanMode', { plan: '' })).toBeUndefined()
    expect(planText('ExitPlanMode', {})).toBeUndefined()
  })
})

describe('DSH approval bridge', () => {
  it('audits pending and allowed decisions', async () => {
    const state = active()
    const request = vi.fn(async () => 'allowed-once' as const)
    const markActivity = vi.fn()
    const canUseTool = createPermissionBridge({ request }, () => ({ ...state, markActivity }))
    await expect(canUseTool('Edit', { file_path: 'a.txt' }, toolOptions())).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-1',
    })
    expect(markActivity).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      agent: state.agent,
      toolName: 'Edit',
    }))
    expect(state.events.map(event => (event.data as { phase: string }).phase)).toEqual(['started', 'completed'])
  })

  it('fails closed when no turn owns the request', async () => {
    const request = vi.fn(async () => 'allowed-once' as const)
    const canUseTool = createPermissionBridge({ request }, () => undefined)
    await expect(canUseTool('Bash', {}, toolOptions())).resolves.toMatchObject({ behavior: 'deny' })
    expect(request).not.toHaveBeenCalled()
  })

  it('routes AskUserQuestion before Full access and never opens approval', async () => {
    const state = active()
    const request = vi.fn(async () => 'allowed-once' as const)
    const userQuestion = vi.fn(async () => ({
      behavior: 'allow' as const,
      updatedInput: { questions: [], answers: {} },
    }))
    const hasFullAccess = vi.fn(async () => true)
    const canUseTool = createPermissionBridge({ request }, () => ({
      ...state,
      hasFullAccess,
    }), userQuestion)

    await expect(canUseTool('AskUserQuestion', { questions: [] }, toolOptions())).resolves.toMatchObject({ behavior: 'allow' })
    expect(userQuestion).toHaveBeenCalledOnce()
    expect(hasFullAccess).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('honors Full access selected while an approval request is pending', async () => {
    const state = active()
    let fullAccess = false
    const request = vi.fn(async () => {
      fullAccess = true
      return 'rejected' as const
    })
    const canUseTool = createPermissionBridge({ request }, () => ({
      ...state,
      hasFullAccess: async () => fullAccess,
    }))

    await expect(canUseTool('Bash', { command: 'git pull --ff-only' }, toolOptions())).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-1',
    })
    expect(state.events.at(-1)?.data).toMatchObject({ phase: 'completed', summary: 'Allowed by Full access in DeepSeek Harness' })
  })

  it('asks for a plan even under Full access', async () => {
    const state = active()
    const request = vi.fn(async () => 'allowed-once' as const)
    const hasFullAccess = vi.fn(async () => true)
    const canUseTool = createPermissionBridge({ request }, () => ({ ...state, hasFullAccess }))

    await expect(canUseTool('ExitPlanMode', { plan: '# Plan' }, toolOptions())).resolves.toMatchObject({ behavior: 'allow' })
    // A plan is the decision the user asked for; Full access waives actions,
    // not decisions.
    expect(request).toHaveBeenCalledOnce()
    expect(state.events.at(-1)?.data).toMatchObject({ phase: 'completed', summary: 'Allowed once in DeepSeek Harness' })
    // Everything else still short-circuits.
    request.mockClear()
    await expect(canUseTool('Bash', { command: 'ls' }, toolOptions())).resolves.toMatchObject({ behavior: 'allow' })
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps a rejected plan rejected when Full access lands mid-read', async () => {
    const state = active()
    let fullAccess = false
    // The user switches to Full access while the plan is on screen, then
    // rejects it. The rejection is the answer; the switch is not.
    const request = vi.fn(async () => {
      fullAccess = true
      return 'rejected' as const
    })
    const canUseTool = createPermissionBridge({ request }, () => ({
      ...state,
      hasFullAccess: async () => fullAccess,
    }))

    await expect(canUseTool('ExitPlanMode', { plan: '# Plan' }, toolOptions())).resolves.toMatchObject({ behavior: 'deny' })
    expect(state.events.at(-1)?.data).toMatchObject({ phase: 'denied' })
  })

  it('fails closed when the approval service rejects', async () => {
    const state = active()
    const canUseTool = createPermissionBridge({ request: async () => { throw new Error('audit failed') } }, () => state)
    await expect(canUseTool('Bash', {}, toolOptions())).resolves.toMatchObject({ behavior: 'deny' })
    expect(state.events.at(-1)?.data).toMatchObject({ phase: 'failed', isError: true })
  })
})
