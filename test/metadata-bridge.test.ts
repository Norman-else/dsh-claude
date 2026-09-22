import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CLAUDE_CODE_PRESET_ID } from '../src/constants.ts'
import { mountClaudeMetadata } from '../src/index.ts'
import { ClaudeProcessLimitError, ClaudeTurnBusyError } from '../src/supervisor.ts'
import type { ClaudeAgentCommandService } from '../src/command-bridge.ts'
import { ClaudeSidecarRepository } from '../src/sidecar.ts'
import { latestPlanUsage, resetPlanUsage } from '../src/plan-usage.ts'

function createHostContext() {
  return {
    agentPresets: { composedPreset: vi.fn(() => CLAUDE_CODE_PRESET_ID) },
    logger: { warn: vi.fn() },
  } as unknown as Parameters<typeof mountClaudeMetadata>[0]
}

function createAgent() {
  const statusHandlers: Array<(payload: { status: string }) => void> = []

  const agentCtx = {
    on: (event: string, handler: (payload: { status: string }) => void) => {
      expect(event).toBe('agent/status')
      statusHandlers.push(handler)
      return () => {
        const index = statusHandlers.indexOf(handler)
        if (index >= 0) statusHandlers.splice(index, 1)
      }
    },
    effect: (setup: () => unknown) => {
      const stop = setup() as () => Promise<void> | void
      return typeof stop === 'function' ? stop : () => Promise.resolve()
    },
  } as Record<string, unknown>

  const agent = {
    id: 'agent-1',
    session: { append: vi.fn(async () => undefined) },
    followup: vi.fn(),
    ctx: agentCtx,
  } as unknown as Agent

  return { agent, agentCtx }
}

describe('metadata bridge', () => {
  it('publishes the Claude catalog without registering a Host command', async () => {
    const host = createHostContext()
    const { agent: catalogAgent } = createAgent()
    const published = vi.fn()
    const service: ClaudeAgentCommandService = {
      list: () => [],
    }
    const supervisor = {
      supportedCommands: vi.fn(async () => [{
        name: 'awesome-skills:ci-deploy',
        description: 'Deploy through CI',
        argumentHint: '<env>',
      }]),
      contextUsage: vi.fn(async () => ({
        model: 'claude-test',
        totalTokens: 1,
        maxTokens: 200_000,
        percentage: 0.5,
        categories: [],
      })),
      planUsage: vi.fn(async () => ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 33, resets_at: '2026-08-27T12:00:00Z' } },
      })),
    } as unknown as Parameters<typeof mountClaudeMetadata>[1]
    const sidecar = {
      writeContextUsage: vi.fn(async () => undefined),
    } as unknown as ClaudeSidecarRepository
    const dispose = mountClaudeMetadata(
      host,
      supervisor,
      catalogAgent,
      'default',
      sidecar,
      published,
      () => service,
    )

    await vi.waitFor(() => expect(published).toHaveBeenCalledWith([{
      publicName: 'ci-deploy',
      claudeName: 'awesome-skills:ci-deploy',
      description: 'Deploy through CI',
      hint: '<env>',
      prefixed: false,
    }]))
    expect(catalogAgent.followup).not.toHaveBeenCalled()
    await dispose?.()
  })

  it('waits quietly for a session that is mid-turn instead of warning and retrying', async () => {
    // The metadata lane refuses to disturb a running turn, and the idle
    // transition afterwards runs this again. Warning and retrying on the
    // schedule meant a busy session filled the log for as long as its turn ran.
    vi.useFakeTimers()
    try {
      const host = createHostContext()
      const { agent } = createAgent()
      const supervisor = {
        supportedCommands: vi.fn(async () => { throw new ClaudeTurnBusyError('agent-1') }),
        contextUsage: vi.fn(async () => ({ model: 'claude-test', totalTokens: 1, maxTokens: 200_000, percentage: 0, categories: [] })),
        planUsage: vi.fn(async () => ({})),
      } as unknown as Parameters<typeof mountClaudeMetadata>[1]
      const sidecar = { writeContextUsage: vi.fn(async () => undefined) } as unknown as ClaudeSidecarRepository
      const dispose = mountClaudeMetadata(host, supervisor, agent, 'default', sidecar, vi.fn(), () => ({ list: () => [] }))
      await vi.advanceTimersByTimeAsync(0)
      expect(supervisor.supportedCommands).toHaveBeenCalledTimes(1)
      // Well past every retry the catalog schedule would have made.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(supervisor.supportedCommands).toHaveBeenCalledTimes(1)
      expect(host.logger.warn).not.toHaveBeenCalled()
      // The refreshes behind the catalog would fail the same way; the next idle
      // pass does all three.
      expect(supervisor.contextUsage).not.toHaveBeenCalled()
      expect(supervisor.planUsage).not.toHaveBeenCalled()
      await dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps retrying the catalog quietly while the process pool is full', async () => {
    // A full pool is another session's turn: no idle transition of this one is
    // coming, so the bounded retry stays, only the warning goes.
    vi.useFakeTimers()
    try {
      const host = createHostContext()
      const { agent } = createAgent()
      let calls = 0
      const supervisor = {
        supportedCommands: vi.fn(async () => {
          calls += 1
          if (calls === 1) throw new ClaudeProcessLimitError(4)
          return []
        }),
        contextUsage: vi.fn(async () => ({ model: 'claude-test', totalTokens: 1, maxTokens: 200_000, percentage: 0, categories: [] })),
        planUsage: vi.fn(async () => ({})),
      } as unknown as Parameters<typeof mountClaudeMetadata>[1]
      const sidecar = { writeContextUsage: vi.fn(async () => undefined) } as unknown as ClaudeSidecarRepository
      const dispose = mountClaudeMetadata(host, supervisor, agent, 'default', sidecar, vi.fn(), () => ({ list: () => [] }))
      await vi.advanceTimersByTimeAsync(0)
      expect(supervisor.supportedCommands).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(supervisor.supportedCommands).toHaveBeenCalledTimes(2)
      expect(host.logger.warn).not.toHaveBeenCalled()
      await dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still reports a catalog failure that is not a busy session', async () => {
    const host = createHostContext()
    const { agent } = createAgent()
    const supervisor = {
      supportedCommands: vi.fn(async () => { throw new Error('CLI exploded') }),
      contextUsage: vi.fn(async () => ({ model: 'claude-test', totalTokens: 1, maxTokens: 200_000, percentage: 0, categories: [] })),
      planUsage: vi.fn(async () => ({})),
    } as unknown as Parameters<typeof mountClaudeMetadata>[1]
    const sidecar = { writeContextUsage: vi.fn(async () => undefined) } as unknown as ClaudeSidecarRepository
    const dispose = mountClaudeMetadata(host, supervisor, agent, 'default', sidecar, vi.fn(), () => ({ list: () => [] }))
    await vi.waitFor(() => expect(host.logger.warn).toHaveBeenCalled())
    expect(String(host.logger.warn.mock.calls[0]?.[0])).toContain('command catalog refresh failed')
    await dispose?.()
  })

  it('caches plan usage for the session-less settings page', async () => {
    resetPlanUsage()
    const host = createHostContext()
    const { agent } = createAgent()
    const supervisor = {
      supportedCommands: vi.fn(async () => []),
      contextUsage: vi.fn(async () => ({ model: 'claude-test', totalTokens: 1, maxTokens: 200_000, percentage: 0.5, categories: [] })),
      planUsage: vi.fn(async () => ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 33, resets_at: '2026-08-27T12:00:00Z' } },
      })),
    } as unknown as Parameters<typeof mountClaudeMetadata>[1]
    const sidecar = { writeContextUsage: vi.fn(async () => undefined) } as unknown as ClaudeSidecarRepository
    const dispose = mountClaudeMetadata(host, supervisor, agent, 'default', sidecar, vi.fn(), () => ({ list: () => [] }))

    await vi.waitFor(() => expect(latestPlanUsage()?.windows).toEqual([
      { id: 'five_hour', utilization: 33, resetsAt: '2026-08-27T12:00:00Z' },
    ]))
    expect(latestPlanUsage()?.subscription).toBe('max')
    await dispose?.()
  })

  it('retries command projection when the preset service becomes available later', async () => {
    const host = createHostContext()
    const { agent } = createAgent()
    const published = vi.fn()

    let service: ClaudeAgentCommandService | undefined
    const resolveCommands = vi.fn(() => service)

    const supervisor = {
      supportedCommands: vi.fn(async () => [{
        name: 'review',
        description: 'Review current changes',
        argumentHint: '<path>',
      }]),
      contextUsage: vi.fn(async () => ({
        model: 'claude-test',
        totalTokens: 1,
        maxTokens: 200_000,
        percentage: 0.5,
        categories: [],
      })),
      planUsage: vi.fn(async () => ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 33, resets_at: '2026-08-27T12:00:00Z' } },
      })),
    } as unknown as Parameters<typeof mountClaudeMetadata>[1]

    const sidecar = {
      writeContextUsage: vi.fn(async () => undefined),
    } as unknown as ClaudeSidecarRepository
    const dispose = mountClaudeMetadata(
      host,
      supervisor,
      agent,
      'default',
      sidecar,
      published,
      resolveCommands,
    )
    expect(dispose).toBeDefined()

    // Provide the service only after the first metadata refresh, mimicking
    // the preset subtree's isolate-realm service landing late.
    setTimeout(() => {
      service = { list: () => [] }
    }, 100)

    await vi.waitFor(() => {
      expect(published).toHaveBeenCalledWith([expect.objectContaining({ publicName: 'review' })])
    }, {
      timeout: 6_000,
      interval: 50,
    })

    await dispose?.()

    expect(supervisor.supportedCommands).toHaveBeenCalled()
    expect(published).toHaveBeenLastCalledWith([])
    expect((supervisor.contextUsage as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})
