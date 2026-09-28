import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/preset-route.ts'
import { CLAUDE_CODE_PROVIDER } from '../src/constants.ts'
import { recordClaudeModels, resetClaudeModels } from '../src/model-catalog.ts'

type RequestListener = (payload: unknown, next: () => Promise<{ provider?: string; model?: string }>) => Promise<{ provider?: string; model?: string }>

function capture(jobs?: { attachController(name: string): () => void }): { ctx: Context; listener: () => RequestListener; registered: () => readonly string[]; provided: () => { name: string; value: unknown } | undefined } {
  let listener: RequestListener = () => { throw new Error('unregistered') }
  const names: string[] = []
  let service: { name: string; value: unknown } | undefined
  const ctx = {
    on: (event: string, handler: RequestListener) => {
      expect(event).toBe('agent/request')
      listener = handler
    },
    effect: (setup: () => unknown) => { setup() },
    // Optional-service inject: the callback runs only when the Host has it.
    inject: (names: readonly string[], setup: (scoped: unknown) => void) => {
      expect(names).toEqual(['jobs'])
      if (jobs !== undefined) setup({ jobs, effect: (run: () => unknown) => { run() } })
    },
    provide: (name: string, value: unknown) => { service = { name, value } },
    tools: {
      register: (definition: { name: string }) => {
        names.push(definition.name)
        return () => undefined
      },
    },
  } as unknown as Context
  return { ctx, listener: () => listener, registered: () => names, provided: () => service }
}

describe('Claude preset route', () => {
  it('preserves the upstream selected model alias', async () => {
    const captured = capture()
    apply(captured.ctx)
    const result = await captured.listener()({} as never, async () => ({ provider: 'upstream-provider', model: 'opus' }))
    expect(result).toEqual({ provider: CLAUDE_CODE_PROVIDER, model: 'opus' })
  })

  it('defaults to default when upstream carries no model', async () => {
    const captured = capture()
    apply(captured.ctx)
    const result = await captured.listener()({} as never, async () => ({ provider: 'upstream-provider' }))
    expect(result).toEqual({ provider: CLAUDE_CODE_PROVIDER, model: 'default' })
  })

  it('lets explicit route config override the upstream selection', async () => {
    const captured = capture()
    apply(captured.ctx, { model: 'sonnet' })
    const result = await captured.listener()({} as never, async () => ({ provider: 'upstream-provider', model: 'opus' }))
    expect(result).toEqual({ provider: CLAUDE_CODE_PROVIDER, model: 'sonnet' })
  })

  it('registers presentation-only tool mirrors into the preset scope', () => {
    const captured = capture()
    apply(captured.ctx)
    expect(captured.registered()).toEqual([
      'Bash', 'PowerShell', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
      'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task', 'ExitPlanMode', 'TodoWrite',
    ])
  })

  it('provides only the agent-scope command directory for collision checks', () => {
    const captured = capture()
    apply(captured.ctx)
    const service = captured.provided()
    expect(service?.name).toBe('claudeCommands')
    expect(typeof (service?.value as { list?: unknown }).list).toBe('function')
    expect((service?.value as { register?: unknown }).register).toBeUndefined()
  })

  it('attaches a job controller for its agents when the Host has a job registry', () => {
    const attached: string[] = []
    apply(capture({ attachController: name => { attached.push(name); return () => undefined } }).ctx)
    expect(attached).toEqual(['dsh-claude'])
  })

  it('records the selector id for a model the lineup maps, and leaves an unmapped one alone', async () => {
    recordClaudeModels([
      { value: 'opus[1m]', displayName: 'Opus (1M context)', description: '' },
      { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: '' },
    ])
    const captured = capture()
    apply(captured.ctx)
    const route = (model: string) => captured.listener()({} as never, async () => ({ provider: 'claude', model }))
    await expect(route('claude-fable-5-1[1m]')).resolves.toMatchObject({ model: 'fable[1m]' })
    await expect(route('claude-fable-5-2[1m]')).resolves.toMatchObject({ model: 'fable[1m]' })
    await expect(route('opus[1m]')).resolves.toMatchObject({ model: 'opus[1m]' })
    await expect(route('something-else')).resolves.toMatchObject({ model: 'something-else' })
    resetClaudeModels()
  })
})
