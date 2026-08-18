import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { CLAUDE_CODE_PROVIDER } from './constants.ts'

export const name = 'claude-code-preset-route'

export interface Config {
  model?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.on('agent/request', async (_payload, next) => {
    const upstream = await next()
    return {
      ...upstream,
      provider: CLAUDE_CODE_PROVIDER,
      model: config.model ?? upstream.model ?? 'default',
    }
  })
}
