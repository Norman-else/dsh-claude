import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/preset-route.ts'
import { CLAUDE_CODE_PROVIDER } from '../src/constants.ts'

type RequestListener = (payload: unknown, next: () => Promise<{ provider?: string; model?: string }>) => Promise<{ provider?: string; model?: string }>

function capture(): { ctx: Context; listener: () => RequestListener; registered: () => readonly string[]; provided: () => { name: string; value: unknown } | undefined } {
  let listener: RequestListener = () => { throw new Error('unregistered') }
  const names: string[] = []
  let service: { name: string; value: unknown } | undefined
  const ctx = {
    on: (event: string, handler: RequestListener) => {
      expect(event).toBe('agent/request')
      listener = handler
    },
    effect: (setup: () => unknown) => { setup() },
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
      'Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
      'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite',
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
})
