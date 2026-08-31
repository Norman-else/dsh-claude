import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_DOCTOR_PATH } from './constants.ts'
import { runClaudeDoctor, type ExecutableRuntime } from './executable.ts'
import type { ClaudeSupervisor, ClaudeSupervisorConfig } from './supervisor.ts'
import { redactText } from './events.ts'
import { registerPluginRoute } from './http.ts'

export const CLAUDE_DOCTOR_PROBE_TIMEOUT_MS = 15_000

/** Live metadata-bridge state per agent, maintained by the host plugin. */
export interface ClaudeBridgeDiagnostic {
  attempts: number
  lastError?: string
  lastCatalog?: number
  registered?: string[]
}

export const claudeBridgeDiagnostics = new WeakMap<Agent, ClaudeBridgeDiagnostic>()

function safeMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), 1_000)
}

/** Live command-bridge diagnostics: which agents exist, their presets, and how
 *  many slash commands each agent's registry layer resolves. */
function commandDiagnostics(ctx: Context): unknown {
  try {
    const agents = ctx.agents.list()
    return {
      total: agents.length,
      agents: agents.map(agent => {
        const info: { id: string; preset?: string; commandCount?: number; sample?: string[]; error?: string; bridge?: ClaudeBridgeDiagnostic } = { id: String(agent.id) }
        try {
          const preset = ctx.agentPresets.composedPreset(agent.ctx)
          if (preset !== undefined) info.preset = preset
        } catch (error) {
          info.error = safeMessage(error)
        }
        try {
          const list = ctx.commands.list(agent)
          info.commandCount = list.length
          info.sample = list.slice(0, 10).map(command => command.name)
        } catch (error) {
          info.error = info.error === undefined ? safeMessage(error) : `${info.error}; ${safeMessage(error)}`
        }
        const bridge = claudeBridgeDiagnostics.get(agent)
        if (bridge !== undefined) info.bridge = bridge
        return info
      }),
    }
  } catch (error) {
    return { error: safeMessage(error) }
  }
}

export function registerClaudeDoctorRoutes(
  ctx: Context,
  runtime: ExecutableRuntime,
  supervisor: ClaudeSupervisor,
  config: ClaudeSupervisorConfig,
  resolutionError?: unknown,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_DOCTOR_PATH,
    methods: ['GET'],
    budget: 'git',
    handler: async io => {
      try {
        if (resolutionError !== undefined) {
          return { status: 200, value: {
            executable: {
              status: 'missing',
              searched: config.executablePath.length > 0 ? [config.executablePath] : ['claude', '~/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
            },
            version: { status: 'not-run' },
            authentication: { status: 'not-run' },
            handshake: 'not-run',
            message: safeMessage(resolutionError),
            limits: {
              idleTimeoutMs: config.idleTimeoutMs,
              maxProcesses: config.maxProcesses,
            },
            processes: { count: 0, active: 0 },
          } }
        }
        const report = await runClaudeDoctor(runtime, {
          configuredPath: config.executablePath,
          cwd: process.cwd(),
          // Threaded so freeing the socket also stops the probe, rather than
          // leaving a spawn nobody is waiting for; the ceiling stays its own.
          signal: AbortSignal.any([io.signal, AbortSignal.timeout(CLAUDE_DOCTOR_PROBE_TIMEOUT_MS)]),
        })
        const processes = supervisor.snapshots()
        if (processes.some(process => process.claudeSessionId !== undefined)) report.handshake = 'ok'
        return { status: 200, value: {
          ...report,
          limits: {
            idleTimeoutMs: config.idleTimeoutMs,
            maxProcesses: config.maxProcesses,
          },
          processes: {
            count: processes.length,
            active: processes.filter(process => process.state === 'running' || process.state === 'starting').length,
          },
          commandBridge: commandDiagnostics(ctx),
        } }
      } catch (error) {
        return { status: 500, value: { error: safeMessage(error) } }
      }
    },
  })
}
