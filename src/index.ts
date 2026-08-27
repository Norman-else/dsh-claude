import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { CLAUDE_CODE_PRESET_ID, CLAUDE_CODE_PROVIDER_IDS } from './constants.ts'
import { CLAUDE_COMMANDS_SERVICE, projectClaudeCommands, type ClaudeAgentCommandService, type ClaudeCommandView } from './command-bridge.ts'
import { ClaudeSidecarRepository } from './sidecar.ts'
import { resolveClaudeExecutable } from './executable.ts'
import { ClaudeSupervisor } from './supervisor.ts'
import { createClaudeCodeAdapter } from './adapter.ts'
import { ensureManagedPreset, ManagedPresetConflictError } from './preset-installer.ts'
import { claudeBridgeDiagnostics, registerClaudeDoctorRoutes, type ClaudeBridgeDiagnostic } from './doctor-routes.ts'
import { registerClaudeProjectionRoute } from './projection-routes.ts'
import { RepositoryStatusService } from './repository-status.ts'
import { RepositorySetupService } from './repository-setup.ts'
import { RepositoryActionService } from './repository-actions.ts'
import { registerRepositorySetupRoute } from './repository-setup-routes.ts'
import { registerRepositoryActionRoute } from './repository-action-routes.ts'
import { PullRequestFeedbackService } from './pr-feedback.ts'
import { registerPullRequestFeedbackRoute } from './pr-feedback-routes.ts'
import { registerRepositoryStatusRoute } from './repository-status-routes.ts'
import { JiraService } from './jira.ts'
import { registerJiraRoute } from './jira-routes.ts'
import { AskService } from './ask.ts'
import { registerAskRoute } from './ask-routes.ts'
import { registerReviewCommentRoute } from './review-comment-routes.ts'
import { ReviewCommentStore } from './review-comments.ts'
import { registerClaudeUpdateRoutes } from './update-routes.ts'
import { readSupervisorLimitOverrides, readWorktreeBranchPrefix, registerClaudeGlobalSettingsRoute } from './global-settings.ts'

export const name = 'llm-claude'
export const inject = ['llm', 'agents', 'agentPresets', 'commands', 'subprocess', 'approval', 'userQuestions', 'attachments']

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

const CLAUDE_SCOPE_UNAVAILABLE_MESSAGE = 'agent command scope unavailable (preset route not mounted?)'
const CATALOG_RETRY_MS = 5_000
const SCOPE_RETRY_MS = 500
const MAX_CATALOG_RETRIES = 3
const MAX_SCOPE_RETRIES = 24

export function mountClaudeMetadata(
  ctx: Context,
  supervisor: ClaudeSupervisor,
  agent: Agent,
  model: string,
  sidecar: ClaudeSidecarRepository,
  publishCommands: (commands: readonly ClaudeCommandView[]) => void = () => {},
  // IMPORTANT: call through the injected agentPresets SERVICE, never an
  // imported serviceForAgent() — a linked plugin resolves peer packages from
  // its own node_modules, which creates a second module instance with empty
  // module-level mount state. The service method runs on the app's instance.
  resolveCommands: () => ClaudeAgentCommandService | undefined =
    () => ctx.agentPresets.serviceFor(agent, CLAUDE_COMMANDS_SERVICE),
): (() => Promise<void>) | undefined {
  if (ctx.agentPresets.composedPreset(agent.ctx) !== CLAUDE_CODE_PRESET_ID) return undefined

  let stopped = false
  let pending = Promise.resolve()
  let commandScope: ClaudeAgentCommandService | undefined

  // The commands service is unreachable from this host view of agent.ctx;
  // the preset route plugin provides it as an isolated per-session service.
  const scopedCommands = () => {
    const scoped = commandScope ?? resolveCommands()
    if (scoped === undefined) throw new Error(CLAUDE_SCOPE_UNAVAILABLE_MESSAGE)
    commandScope = scoped
    return scoped
  }

  const commandTarget = {
    list: () => scopedCommands().list(agent),
  }

  const warn = (area: string, error: unknown) => {
    ctx.logger.warn(`dsh-claude: ${area} refresh failed for ${String(agent.id)}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const isScopeUnavailable = (error: unknown): boolean => {
    if (error instanceof Error) return error.message === CLAUDE_SCOPE_UNAVAILABLE_MESSAGE
    return String(error) === CLAUDE_SCOPE_UNAVAILABLE_MESSAGE
  }

  const diagnostic: ClaudeBridgeDiagnostic = claudeBridgeDiagnostics.get(agent) ?? { attempts: 0 }
  claudeBridgeDiagnostics.set(agent, diagnostic)

  // A fresh session's first catalog fetch races CLI startup (skills/plugins
  // can make init slow); retry with backoff so the command palette still
  // populates without waiting for the first completed turn.
  let catalogRetries = 0
  let scopeRetries = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleRetry = (area: 'command catalog' | 'command scope', attempt: number) => {
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    const delay = area === 'command catalog' ? CATALOG_RETRY_MS * attempt : Math.min(SCOPE_RETRY_MS * 2 ** attempt, 5_000)
    retryTimer = setTimeout(() => {
      if (!stopped) refresh()
    }, delay)
    retryTimer.unref?.()
  }

  const refresh = () => {
    pending = pending.then(async () => {
      if (stopped) return
      diagnostic.attempts += 1

      let catalog: Awaited<ReturnType<ClaudeSupervisor['supportedCommands']>> | undefined

      try {
        const result = await supervisor.supportedCommands(agent, model)
        catalog = result
        catalogRetries = 0
        scopeRetries = 0
        diagnostic.lastCatalog = catalog.length
        delete diagnostic.lastError
      } catch (error) {
        diagnostic.lastError = error instanceof Error ? error.message : String(error)
        warn('command catalog', error)
        if (!stopped && catalogRetries < MAX_CATALOG_RETRIES) {
          catalogRetries += 1
          scheduleRetry('command catalog', catalogRetries)
        }
      }

      if (stopped || catalog === undefined) return

      try {
        const commands = projectClaudeCommands(catalog, commandTarget)
        publishCommands(commands)
        diagnostic.registered = commands.map(view => view.publicName)
        if (!stopped) scopeRetries = 0
      } catch (error) {
        diagnostic.lastError = error instanceof Error ? error.message : String(error)
        warn('command catalog', error)
        if (!stopped && isScopeUnavailable(error) && scopeRetries < MAX_SCOPE_RETRIES) {
          scopeRetries += 1
          scheduleRetry('command scope', scopeRetries)
        }
      }

      if (stopped) return
      try {
        const usage = await supervisor.contextUsage(agent, model)
        if (!stopped) await sidecar.writeContextUsage(agent.id as string, usage)
      } catch (error) {
        warn('context usage', error)
      }
    })
  }

  return agent.ctx.effect(() => {
    const stopStatus = agent.ctx.on('agent/status', ({ status }) => {
      if (status === 'idle') refresh()
    })

    refresh()

    return async () => {
      stopped = true
      publishCommands([])
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      stopStatus()
      await pending
    }
  }, 'dsh-claude: agent metadata bridge')
}

export async function installManagedPresetCompatibility(
  logger: Pick<Context['logger'], 'warn'>,
  install: typeof ensureManagedPreset = ensureManagedPreset,
): Promise<'installed' | 'unchanged' | 'conflict'> {
  try {
    return await install()
  } catch (error) {
    if (!(error instanceof ManagedPresetConflictError)) throw error
    logger.warn(`dsh-claude: preserving user-modified preset at ${error.path}`)
    return 'conflict'
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // DSH rc.6-rc.8 replaces third-party preset roots during profile boot. Keep
  // the package-contained preset for compatible Hosts, and install this guarded
  // copy into DSH's always-loaded user preset root for affected Hosts.
  await installManagedPresetCompatibility(ctx.logger)
  const defaultLimits = {
    idleTimeoutMs: config.idleTimeoutMs ?? 30 * 60 * 1_000,
    maxProcesses: config.maxProcesses ?? 4,
  }
  const supervisorConfig = {
    executablePath: '',
    defaultModel: config.model ?? 'default',
    ...defaultLimits,
  }
  // Settings overrides win over the plugin config; the supervisor reads the
  // shared config object on every admission and idle schedule, so updates
  // take effect without a restart.
  const applyLimitOverrides = async (): Promise<void> => {
    const overrides = await readSupervisorLimitOverrides()
    supervisorConfig.idleTimeoutMs = overrides.idleTimeoutMs ?? defaultLimits.idleTimeoutMs
    supervisorConfig.maxProcesses = overrides.maxProcesses ?? defaultLimits.maxProcesses
  }
  await applyLimitOverrides()
  const sidecar = new ClaudeSidecarRepository()
  const repositoryStatus = new RepositoryStatusService(ctx.subprocess)
  const repositorySetup = new RepositorySetupService(ctx.subprocess, { branchPrefix: () => readWorktreeBranchPrefix() })
  const reviewComments = new ReviewCommentStore()
  const commandCatalogs = new Map<string, readonly ClaudeCommandView[]>()
  const supervisor = new ClaudeSupervisor({
    runtime: ctx.subprocess,
    approval: ctx.approval,
    userQuestions: ctx.userQuestions,
    config: supervisorConfig,
    runDetached: operation => ctx.agents.withoutInitiator(operation),
    sidecar,
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
      [...CLAUDE_CODE_PROVIDER_IDS],
      createClaudeCodeAdapter(supervisor, ctx.agents, ctx.attachments, agent => ctx.agentPresets.composedPreset(agent.ctx), sessionId => reviewComments.drain(sessionId)),
    )
    ctx.effect(() => {
      const mounted = new Map<Agent, () => Promise<void>>()
      const pending = new Set<Agent>()
      const MOUNT_RETRY_MS = 200
      const MOUNT_RETRY_LIMIT = 50
      const mount = (agent: Agent) => {
        if (mounted.has(agent)) return
        const sessionId = agent.id as string
        const dispose = mountClaudeMetadata(
          ctx,
          supervisor,
          agent,
          supervisorConfig.defaultModel,
          sidecar,
          commands => {
            if (commands.length === 0) commandCatalogs.delete(sessionId)
            else commandCatalogs.set(sessionId, commands)
          },
        )
        if (dispose !== undefined) mounted.set(agent, dispose)
        pending.delete(agent)
      }
      // The standing preset mount lands AFTER agent/created (the PresetTree is
      // applied asynchronously), so composedPreset is still undefined at that
      // point. Poll briefly until the join settles, then decide.
      const mountWhenPresetSettles = (agent: Agent) => {
        if (mounted.has(agent) || pending.has(agent)) return
        if (ctx.agentPresets.composedPreset(agent.ctx) !== undefined) {
          mount(agent)
          return
        }
        pending.add(agent)
        let attempts = 0
        const retry = () => {
          if (mounted.has(agent) || !pending.has(agent)) return
          if (ctx.agentPresets.composedPreset(agent.ctx) !== undefined) {
            mount(agent)
            return
          }
          attempts += 1
          if (attempts >= MOUNT_RETRY_LIMIT) {
            pending.delete(agent)
            return
          }
          const timer = setTimeout(retry, MOUNT_RETRY_MS)
          timer.unref?.()
        }
        const timer = setTimeout(retry, MOUNT_RETRY_MS)
        timer.unref?.()
      }
      const stopCreated = ctx.on('agent/created', ({ agent }) => { mountWhenPresetSettles(agent) })
      // Belt and suspenders: the session records its preset selection as a
      // durable event, which agent-presets republishes as agent-preset/selected.
      // agent-preset/selected is emitted by dsh-agent-presets but is not part
      // of the typed host event map yet; subscribe through a typed escape hatch.
      const onPresetSelected = ctx.on as (event: 'agent-preset/selected', handler: (sessionId: string, preset: string) => void) => () => void
      const stopSelected = onPresetSelected('agent-preset/selected', (sessionId, preset) => {
        if (preset !== CLAUDE_CODE_PRESET_ID) return
        const agent = ctx.agents.get(sessionId as never)
        if (agent !== undefined) mountWhenPresetSettles(agent)
      })
      for (const agent of ctx.agents.list()) mountWhenPresetSettles(agent)
      return async () => {
        stopCreated()
        stopSelected()
        pending.clear()
        await Promise.allSettled([...mounted.values()].map(dispose => dispose()))
        mounted.clear()
      }
    }, 'dsh-claude: metadata bridges')
  } catch (error) {
    resolutionError = error
  }
  ctx.on('agent/disposed', async ({ agent }) => {
    reviewComments.disposeSession(agent.id as string)
    await supervisor.disposeSession(agent.id as string)
  })
  // Deleting a workspace from the sidebar is a durable-registry mutation with
  // no agent lifecycle edge, so worktree cleanup reconciles leases against
  // the workspace registry instead: unreferenced clean worktrees are removed
  // on boot and on a slow interval. workspaceRegistry is not part of this
  // plugin's typed host surface yet; inject through an untyped escape hatch
  // so older Hosts without the service simply never start the sweep.
  const injectWorkspaceRegistry = ctx.inject as unknown as (
    deps: readonly string[],
    callback: (sweepCtx: Context & { workspaceRegistry: { list(): readonly { readonly path: string }[] } }) => void,
  ) => void
  injectWorkspaceRegistry(['workspaceRegistry'], sweepCtx => {
    const sweep = (): void => {
      try {
        const paths = sweepCtx.workspaceRegistry.list().map(workspace => workspace.path)
        void repositorySetup.cleanupOrphans(paths).catch(() => undefined)
      } catch {
        // The registry can be mid-teardown; skip this pass.
      }
    }
    sweepCtx.effect(() => {
      sweep()
      const timer = setInterval(sweep, 60_000)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'dsh-claude: worktree reconciliation')
  })
  ctx.effect(() => () => reviewComments.dispose(), 'dsh-claude: review comments store')
  ctx.effect(() => () => supervisor.dispose(), 'dsh-claude: process supervisor')
  ctx.effect(() => () => repositoryStatus.dispose(), 'dsh-claude: repository status cache')
  ctx.inject(['webServer'], webCtx => {
    registerClaudeDoctorRoutes(webCtx, webCtx.subprocess, supervisor, supervisorConfig, resolutionError)
    const desktopActions = webCtx.get('desktopActions') as { requestRestart?: () => void } | undefined
    registerClaudeUpdateRoutes(webCtx, webCtx.subprocess, {
      ...(typeof desktopActions?.requestRestart === 'function'
        ? { requestRestart: desktopActions.requestRestart.bind(desktopActions) }
        : {}),
    })
    registerClaudeGlobalSettingsRoute(webCtx, { defaultLimits, onUpdated: applyLimitOverrides })
    registerRepositorySetupRoute(webCtx, repositorySetup)
    registerRepositoryStatusRoute(webCtx, repositoryStatus)
    registerJiraRoute(webCtx, new JiraService())
    const repositoryActions = new RepositoryActionService(webCtx.subprocess, supervisorConfig.executablePath, cwd => repositoryStatus.invalidate(cwd))
    const cwdForClaudeSession = (sessionId: string): string | undefined => {
      const agent = webCtx.agents.get(sessionId as never)
      if (agent === undefined || webCtx.agentPresets.composedPreset(agent.ctx) !== CLAUDE_CODE_PRESET_ID) return undefined
      return agent.session.header.cwd
    }
    registerRepositoryActionRoute(webCtx, repositoryActions, cwdForClaudeSession)
    registerPullRequestFeedbackRoute(webCtx, new PullRequestFeedbackService(webCtx.subprocess), cwdForClaudeSession)
    registerAskRoute(webCtx, new AskService(webCtx.subprocess, supervisorConfig.executablePath), cwdForClaudeSession, sessionId => {
      const snapshot = supervisor.snapshots().find(item => item.sessionId === sessionId)
      return snapshot === undefined ? undefined : { model: snapshot.model, ...(snapshot.thinkingMode === undefined ? {} : { thinkingMode: snapshot.thinkingMode }) }
    })
    const ownsClaudeSession = (sessionId: string): boolean => {
      const agent = webCtx.agents.get(sessionId as never)
      return agent !== undefined && webCtx.agentPresets.composedPreset(agent.ctx) === CLAUDE_CODE_PRESET_ID
    }
    registerReviewCommentRoute(webCtx, reviewComments, ownsClaudeSession)
    registerClaudeProjectionRoute(webCtx, sidecar, ownsClaudeSession, sessionId => commandCatalogs.get(sessionId) ?? [], async sessionId => {
      const agent = webCtx.agents.get(sessionId as never)
      if (agent === undefined || webCtx.agentPresets.composedPreset(agent.ctx) !== CLAUDE_CODE_PRESET_ID) return undefined
      const cwd = agent.session.header.cwd
      return cwd === undefined ? undefined : repositoryStatus.inspect(cwd)
    }, sessionId => reviewComments.list(sessionId))
  })
}
