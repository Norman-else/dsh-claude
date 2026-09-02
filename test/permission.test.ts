import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createPermissionBridge, mapApprovalOutcome, permissionReason } from '../src/permission.ts'

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

  it('hands the plan itself to the approval surface', () => {
    const plan = `## Plan\n\n1. Read ${'the supervisor '.repeat(200)}\n2. Ship it`
    const reason = permissionReason('ExitPlanMode', { plan }, toolOptions())
    // The plan is prose the user is being asked to agree to, so it arrives as
    // prose rather than as `Input: {"plan":"..."}`.
    expect(reason.startsWith('## Plan')).toBe(true)
    expect(reason).not.toContain('Input: ')
    // Long enough to hold a real plan, still bounded.
    expect(reason.length).toBeGreaterThan(1_200)
    expect(reason.length).toBeLessThanOrEqual(8_000)
    // An empty or missing plan falls back to the ordinary prompt.
    expect(permissionReason('ExitPlanMode', { plan: '' }, toolOptions())).toContain('Input: ')
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

  it('fails closed when the approval service rejects', async () => {
    const state = active()
    const canUseTool = createPermissionBridge({ request: async () => { throw new Error('audit failed') } }, () => state)
    await expect(canUseTool('Bash', {}, toolOptions())).resolves.toMatchObject({ behavior: 'deny' })
    expect(state.events.at(-1)?.data).toMatchObject({ phase: 'failed', isError: true })
  })
})
