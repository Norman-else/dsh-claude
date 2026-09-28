import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
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
  // Expose the effective Host command names for collision-safe projection.
  // Claude Skills are not registered as Host commands: the Client slash source
  // submits them as ordinary messages, so no command lifecycle row is created.
  ctx.provide(CLAUDE_COMMANDS_SERVICE, {
    list: agent => ctx.commands.list(agent as never),
  })
  // Presentation-only tool mirrors, scoped to this preset's agents: they let
  // the host compute native render intents for the mirrored Claude tool
  // events. Claude Code owns execution; the stub `execute` never runs.
  for (const definition of claudePresenterDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-claude: ${definition.name} presentation`)
  }
  // `ctx.jobs.start` refuses an owner no attached controller serves. The
  // shipped presets get theirs from dsh-tool-jobs, which this preset does not
  // load (Claude Code owns job collection); attach one for this preset's
  // agents so mirrored tasks (host-jobs.ts) can register. Optional: a Host
  // without a job registry runs as before.
  ctx.inject(['jobs'], jobsCtx => {
    jobsCtx.effect(() => jobsCtx.jobs.attachController('dsh-claude'), 'dsh-claude: job controller')
  })
}
