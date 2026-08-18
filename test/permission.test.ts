import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createPermissionBridge, mapApprovalOutcome, permissionReason } from '../src/permission.ts'

function active() {
  const events: Array<{ type: string; data: unknown }> = []
  const agent = {
    session: {
      append: async (type: string, data: unknown) => { events.push({ type, data }); return {} },
    },
  } as unknown as Agent
  return { agent, cursor: { turn: 1, step: 1, nextOrdinal: 0 }, events }
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

  it('fails closed when the approval service rejects', async () => {
    const state = active()
    const canUseTool = createPermissionBridge({ request: async () => { throw new Error('audit failed') } }, () => state)
    await expect(canUseTool('Bash', {}, toolOptions())).resolves.toMatchObject({ behavior: 'deny' })
    expect(state.events.at(-1)?.data).toMatchObject({ phase: 'failed', isError: true })
  })
})
