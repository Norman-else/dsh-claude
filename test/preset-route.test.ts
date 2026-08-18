import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/preset-route.ts'
import { CLAUDE_CODE_PROVIDER } from '../src/constants.ts'

type RequestListener = (payload: unknown, next: () => Promise<{ provider?: string; model?: string }>) => Promise<{ provider?: string; model?: string }>

function capture(): { ctx: Context; listener: () => RequestListener } {
  let listener: RequestListener = () => { throw new Error('unregistered') }
  const ctx = {
    on: (event: string, handler: RequestListener) => {
      expect(event).toBe('agent/request')
      listener = handler
    },
  } as unknown as Context
  return { ctx, listener: () => listener }
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
})
