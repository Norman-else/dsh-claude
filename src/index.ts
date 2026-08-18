import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-approval'
import { CLAUDE_CODE_PROVIDER } from './constants.ts'
import { installClaudeEventVocabulary } from './event-vocabulary.ts'
import { resolveClaudeExecutable } from './executable.ts'
import { ClaudeSupervisor } from './supervisor.ts'
import { createClaudeCodeAdapter } from './adapter.ts'
import { ensureManagedPreset } from './preset-installer.ts'
import { registerClaudeDoctorRoutes } from './doctor-routes.ts'

export const name = 'llm-claude-code-cli'
export const inject = ['llm', 'agents', 'agentPresets', 'subprocess', 'approval']

export interface Config {
  executablePath?: string
  model?: string
  idleTimeoutMs?: number
  maxProcesses?: number
}

export const Config: z<Config> = z.object({
  executablePath: z.string().default(''),
  model: z.string().default('default'),
  idleTimeoutMs: z.number().min(1_000).max(2_147_483_647).default(30 * 60 * 1_000),
  maxProcesses: z.number().step(1).min(1).default(4),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  await installClaudeEventVocabulary()
  await ensureManagedPreset()
  const supervisorConfig = {
    executablePath: '',
    defaultModel: config.model ?? 'default',
    idleTimeoutMs: config.idleTimeoutMs ?? 30 * 60 * 1_000,
    maxProcesses: config.maxProcesses ?? 4,
  }
  const supervisor = new ClaudeSupervisor({
    runtime: ctx.subprocess,
    approval: ctx.approval,
    config: supervisorConfig,
    runDetached: operation => ctx.agents.withoutInitiator(operation),
  })
  let resolutionError: unknown
  try {
    const resolution = await resolveClaudeExecutable(
      ctx.subprocess,
      config.executablePath === undefined || config.executablePath.length === 0
        ? undefined
        : config.executablePath,
    )
    supervisorConfig.executablePath = resolution.path
    ctx.llm.registerAdapter(
      [CLAUDE_CODE_PROVIDER],
      createClaudeCodeAdapter(supervisor, ctx.agents, agent => ctx.agentPresets.composedPreset(agent.ctx)),
    )
  } catch (error) {
    resolutionError = error
  }
  ctx.on('agent/disposed', async ({ agent }) => {
    await supervisor.disposeSession(agent.id as string)
  })
  ctx.effect(() => () => supervisor.dispose(), 'dsh-claude-code: process supervisor')
  ctx.inject(['webServer'], webCtx => {
    registerClaudeDoctorRoutes(webCtx, webCtx.subprocess, supervisor, supervisorConfig, resolutionError)
  })
}
