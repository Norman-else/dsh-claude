import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import { CLAUDE_CODE_PROVIDER } from './constants.ts'
import { CLAUDE_COMMANDS_SERVICE } from './command-bridge.ts'
import { claudePresenterDefinitions } from './presenters.ts'

export const name = 'claude-code-preset-route'
export const inject = ['tools', 'commands']

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
  // Provide this agent-scope commands service so the host-side command
  // bridge can register Claude's catalog into exactly this agent's scope
  // layer. The preset row isolates the service per entry (per session); the
  // host reads it via serviceForAgent(ctx, agent, CLAUDE_COMMANDS_SERVICE).
  ctx.provide(CLAUDE_COMMANDS_SERVICE, {
    list: agent => ctx.commands.list(agent as never),
    register: definition => ctx.commands.register(definition),
  })
  // Presentation-only tool mirrors, scoped to this preset's agents: they let
  // the host compute native render intents for the mirrored Claude tool
  // events. Claude Code owns execution; the stub `execute` never runs.
  for (const definition of claudePresenterDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-claude: ${definition.name} presentation`)
  }
}
