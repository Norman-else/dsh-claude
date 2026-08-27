import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CLAUDE_CODE_PRESET_ID } from '../src/constants.ts'
import { mountClaudeMetadata } from '../src/index.ts'
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
