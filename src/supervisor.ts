import { randomUUID } from 'node:crypto'
import {
  query as claudeQuery,
  type EffortLevel,
  type Options as ClaudeOptions,
  type PermissionMode,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type Settings as ClaudeSettings,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { AsyncQueue } from './async-queue.ts'
import { TASK_TOOL_NAMES } from './constants.ts'
import {
  currentClaudeActivityCursor,
  redactText,
  safeDetail,
  type ClaudeActivityCursor,
  type ClaudeActivityInput,
  type ClaudeTaskInfo,
  type ClaudeUsage,
} from './events.ts'
import { createPermissionBridge } from './permission.ts'
import { ClaudeSidecarRepository } from './sidecar.ts'
import { CLAUDE_PRESENTER_NAMES, dynamicPresenterDefinition } from './presenters.ts'
import { normalizeSdkMessage, type NormalizedSdkMessage } from './sdk-messages.ts'
import { createManagedClaudeSpawner, type ManagedClaudeProcess } from './spawn.ts'

export const CLAUDE_INITIALIZATION_TIMEOUT_MS = 30_000
export const CLAUDE_INTERRUPT_TIMEOUT_MS = 5_000
/** Control requests must settle; a wedged one must not clog the metadata chain. */
export const CLAUDE_METADATA_TIMEOUT_MS = 15_000

export type ClaudeSupervisorState =
  | 'starting'
  | 'idle'
  | 'running'
  | 'interrupting'
  | 'disconnected'
  | 'outcome-unknown'
  | 'disposed'

export interface ClaudeSupervisorConfig {
  executablePath: string
  idleTimeoutMs: number
  maxProcesses: number
  defaultModel: string
}

export type ClaudeTurnStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'usage'; usage: ClaudeUsage }
  | { type: 'complete'; text: string }

export type ClaudeThinkingMode = 'off' | 'ultracode' | EffortLevel

export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

const CLAUDE_MODE_BY_SANDBOX: Readonly<Record<DshSandboxMode, PermissionMode>> = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'bypassPermissions',
}

/** Fold DSH's native access selector into Claude Code's closest permission mode. */
export function claudePermissionMode(events: readonly { type: string; data: unknown }[]): PermissionMode {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'sandbox/mode') continue
    const mode = (event.data as { mode?: unknown }).mode
    return typeof mode === 'string' && mode in CLAUDE_MODE_BY_SANDBOX
      ? CLAUDE_MODE_BY_SANDBOX[mode as DshSandboxMode]
      : 'plan'
  }
  return 'plan'
}

export interface ClaudeTurnRequest {
  agent: Agent
  prompt: string
  model?: string
  thinkingMode?: ClaudeThinkingMode
  signal?: AbortSignal
}

export interface ClaudeSupervisorSnapshot {
  sessionId: string
  claudeSessionId?: string
  state: ClaudeSupervisorState
  cwd: string
  model: string
  thinkingMode?: ClaudeThinkingMode
  lastUsedAt: number
  pid?: number
}

export class ClaudeTurnBusyError extends Error {
  constructor(sessionId: string) {
    super(`Claude Code session ${sessionId} already has an active or interrupting turn`)
    this.name = 'ClaudeTurnBusyError'
  }
}

export class ClaudeOutcomeUnknownError extends Error {
  constructor(message = 'Claude Code exited after activity; side-effect outcome is unknown and the prompt was not replayed') {
    super(message)
    this.name = 'ClaudeOutcomeUnknownError'
  }
}

export class ClaudeProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeProtocolError'
  }
}

export class ClaudeProcessLimitError extends Error {
  constructor(maxProcesses: number) {
    super(`Claude Code process limit reached (${maxProcesses}) and no idle session can be evicted`)
    this.name = 'ClaudeProcessLimitError'
  }
}

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: ClaudeOptions
}) => Query

interface ActiveTurn {
  agent: Agent
  cursor: ClaudeActivityCursor
  output: AsyncQueue<ClaudeTurnStreamEvent>
  promptUuid: ReturnType<typeof randomUUID>
  sawActivity: boolean
  sawTextDelta: boolean
  text: string
  thinking: string
  aborted: boolean
  deniedToolUseIds: Set<string>
  /** Root call names by toolUseId; tool results carry none of their own. */
  callNames: Map<string, string>
  signal?: AbortSignal
  abortListener?: () => void
}

interface SupervisorEntry {
  sessionId: string
  ownerAgent: Agent
  cwd: string
  model: string
  thinkingMode: ClaudeThinkingMode | undefined
  permissionMode: PermissionMode
  state: ClaudeSupervisorState
  lastUsedAt: number
  input: AsyncQueue<SDKUserMessage>
  query: Query
  lifetime: AbortController
  process: ManagedClaudeProcess | undefined
  claudeSessionId: string | undefined
  active: ActiveTurn | undefined
  idleTimer: ReturnType<typeof setTimeout> | undefined
  initTimer: ReturnType<typeof setTimeout> | undefined
  initialized: boolean
  expectedResume: string | undefined
  /** Settled when init arrives; rejected on disconnect before init. */
  initWaiters: Array<(error: unknown) => void>
  /** Uuid of the startup handshake prompt; its local-command result is never a DSH turn outcome. */
  handshakeUuid: ReturnType<typeof randomUUID>
  /** True until the handshake's settlement arrives; its output is swallowed. */
  handshakePending: boolean
  /** Live Claude task board (subagents and background tasks), keyed by task id. */
  tasks: Map<string, ClaudeTaskInfo>
  /** Last time a task snapshot was persisted (progress throttling). */
  taskSnapshotAt: number
  /** Pending throttled snapshot flush timer. */
  taskSnapshotTimer: ReturnType<typeof setTimeout> | undefined
  pump: Promise<void>
}

function abortFailure(): Error {
  const error = new Error('Claude Code turn aborted')
  error.name = 'AbortError'
  return error
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function sdkUserMessage(prompt: string, uuid: ReturnType<typeof randomUUID>): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    uuid,
  }
}

/** CLI ≥ 2.1.235 emits system/init only after its first stdin input, while
 *  the supervisor must see init before submitting any real turn. A local
 *  slash command nudges startup without costing a model call; its lifecycle
 *  messages are ignored because no DSH turn is active while they arrive. */
const CLAUDE_HANDSHAKE_PROMPT = '/status'

function usageSummary(usage: ClaudeUsage): string {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cost = usage.cumulativeCostUsd === undefined
    ? ''
    : ` · $${usage.cumulativeCostUsd.toFixed(4)} cumulative`
  return `${input} input / ${output} output tokens${cost}`
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Root-call activity summary; subagent dispatches lead with Claude's own task description. */
function rootCallSummary(toolName: string, input: unknown): string {
  if (TASK_TOOL_NAMES.has(toolName)) {
    const description = input !== null && typeof input === 'object'
      ? (input as Record<string, unknown>).description
      : undefined
    if (typeof description === 'string' && description.length > 0) return description
    return 'Claude dispatched a subagent'
  }
  return `Claude called ${toolName}`
}

export class ClaudeSupervisor {
  readonly #entries = new Map<string, SupervisorEntry>()
  readonly #runtime: Pick<SubprocessRuntime, 'spawn'>
  readonly #approval: Pick<ApprovalService, 'request'>
  readonly #config: ClaudeSupervisorConfig
  readonly #queryFactory: ClaudeQueryFactory
  readonly #runDetached: <T>(operation: () => T) => T
  readonly #sidecar: ClaudeSidecarRepository
  readonly #dynamicPresenterNames = new WeakMap<Agent, Set<string>>()
  readonly #contextWindows = new Map<string, number>()
  #disposed = false
  #admissionGate: Promise<void> = Promise.resolve()

  constructor(dependencies: {
    runtime: Pick<SubprocessRuntime, 'spawn'>
    approval: Pick<ApprovalService, 'request'>
    config: ClaudeSupervisorConfig
    queryFactory?: ClaudeQueryFactory
    runDetached?: <T>(operation: () => T) => T
    sidecar?: ClaudeSidecarRepository
  }) {
    this.#runtime = dependencies.runtime
    this.#approval = dependencies.approval
    this.#config = dependencies.config
    this.#queryFactory = dependencies.queryFactory ?? (params => claudeQuery(params))
    this.#runDetached = dependencies.runDetached ?? (operation => operation())
    this.#sidecar = dependencies.sidecar ?? new ClaudeSidecarRepository()
  }

  snapshots(): ClaudeSupervisorSnapshot[] {
    return [...this.#entries.values()].map(entry => ({
      sessionId: entry.sessionId,
      ...(entry.claudeSessionId === undefined ? {} : { claudeSessionId: entry.claudeSessionId }),
      state: entry.state,
      cwd: entry.cwd,
      model: entry.model,
      ...(entry.thinkingMode === undefined ? {} : { thinkingMode: entry.thinkingMode }),
      lastUsedAt: entry.lastUsedAt,
      ...(entry.process === undefined ? {} : { pid: entry.process.handle.pid }),
    }))
  }

  supportedCommands(agent: Agent, model = this.#config.defaultModel): Promise<readonly SlashCommand[]> {
    return this.#runMetadata(agent, model, query => query.supportedCommands())
  }

  async contextUsage(agent: Agent, model = this.#config.defaultModel): Promise<SDKControlGetContextUsageResponse> {
    const usage = await this.#runMetadata(agent, model, query => query.getContextUsage())
    const contextWindow = usage.rawMaxTokens > 0 ? usage.rawMaxTokens : usage.maxTokens
    if (contextWindow > 0) {
      this.#contextWindows.set(model, contextWindow)
      this.#contextWindows.set(usage.model, contextWindow)
    }
    return usage
  }

  contextWindow(model: string): number | undefined {
    return this.#contextWindows.get(model)
  }

  runTurn(request: ClaudeTurnRequest): Promise<AsyncIterable<ClaudeTurnStreamEvent>> {
    const operation = this.#admissionGate.then(() => this.#runTurnAdmitted(request))
    this.#admissionGate = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #runTurnAdmitted(request: ClaudeTurnRequest): Promise<AsyncIterable<ClaudeTurnStreamEvent>> {
    if (this.#disposed) throw new Error('dsh-claude: supervisor is disposed')
    if (signalAborted(request.signal)) throw abortFailure()
    const sessionId = request.agent.id as string
    let entry = this.#entries.get(sessionId)
    if (entry?.state === 'disposed' || entry?.state === 'disconnected' || entry?.state === 'outcome-unknown') {
      this.#entries.delete(sessionId)
      await this.#disposeEntry(entry)
      entry = undefined
    }
    if (entry === undefined) {
      await this.#makeRoom()
      entry = await this.#createEntry(request.agent, request.model ?? this.#config.defaultModel, request.thinkingMode)
      this.#entries.set(sessionId, entry)
      this.#armInitializationTimer(entry)
    }
    if (entry.ownerAgent !== request.agent) {
      throw new Error(`dsh-claude: live agent identity changed for session ${sessionId}`)
    }
    if (entry.active !== undefined || entry.state === 'interrupting') throw new ClaudeTurnBusyError(sessionId)

    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    const model = request.model ?? this.#config.defaultModel
    if (request.thinkingMode !== entry.thinkingMode) {
      // The SDK only accepts effort/thinking at query start, so rebuild the
      // query; the persisted Claude session binding keeps the context.
      this.#entries.delete(sessionId)
      await this.#disposeEntry(entry)
      entry = await this.#createEntry(request.agent, model, request.thinkingMode)
      this.#entries.set(sessionId, entry)
      this.#armInitializationTimer(entry)
    } else {
      await this.#syncPermissionMode(entry)
      if (model !== entry.model) {
        await entry.query.setModel(model)
        entry.model = model
      }
    }

    const promptUuid = randomUUID()
    const cursor = currentClaudeActivityCursor(request.agent.session.events)
    const projection = await this.#sidecar.read(sessionId)
    cursor.nextOrdinal = projection.activities.reduce((next, activity) => (
      activity.turn === cursor.turn && activity.step === cursor.step
        ? Math.max(next, activity.ordinal + 1)
        : next
    ), 0)
    const active: ActiveTurn = {
      agent: request.agent,
      cursor,
      output: new AsyncQueue<ClaudeTurnStreamEvent>(),
      promptUuid,
      sawActivity: false,
      sawTextDelta: false,
      text: '',
      thinking: '',
      aborted: false,
      deniedToolUseIds: new Set(),
      callNames: new Map(),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    entry.active = active
    entry.state = 'running'
    entry.lastUsedAt = Date.now()
    try {
      await this.#appendActivity(active, {
        kind: 'status',
        phase: 'started',
        title: 'Claude Code turn started',
      })
    } catch (error) {
      active.output.fail(error)
      entry.active = undefined
      if (this.#entries.get(sessionId) === entry) this.#entries.delete(sessionId)
      await this.#disposeEntry(entry)
      throw error
    }
    if (signalAborted(request.signal)) {
      active.aborted = true
      active.output.fail(abortFailure())
      await this.#appendActivity(active, {
        kind: 'status',
        phase: 'failed',
        title: 'Claude Code turn cancelled before submission',
      })
      entry.active = undefined
      entry.state = 'idle'
      entry.lastUsedAt = Date.now()
      this.#armIdleTimer(entry)
      return active.output
    }
    if (request.signal !== undefined) {
      const abortListener = () => { void this.#interrupt(entry as SupervisorEntry) }
      active.abortListener = abortListener
      request.signal.addEventListener('abort', abortListener, { once: true })
    }
    entry.input.push(sdkUserMessage(request.prompt, promptUuid))
    return active.output
  }

  #runMetadata<T>(
    agent: Agent,
    model: string,
    operation: (query: Query, entry: SupervisorEntry) => Promise<T>,
  ): Promise<T> {
    const admitted = this.#admissionGate.then(async () => {
      if (this.#disposed) throw new Error('dsh-claude: supervisor is disposed')
      const entry = await this.#metadataEntry(agent, model)
      try {
        // Control requests go out only after the CLI finishes initializing;
        // issued earlier they can wedge and clog the caller's refresh chain.
        await withTimeout(this.#whenInitialized(entry), CLAUDE_INITIALIZATION_TIMEOUT_MS, 'Claude metadata initialization')
        return await withTimeout(operation(entry.query, entry), CLAUDE_METADATA_TIMEOUT_MS, 'Claude metadata request')
      } finally {
        entry.lastUsedAt = Date.now()
        if (entry.active === undefined && entry.state === 'idle') this.#armIdleTimer(entry)
      }
    })
    this.#admissionGate = admitted.then(() => undefined, () => undefined)
    return admitted
  }

  #whenInitialized(entry: SupervisorEntry): Promise<void> {
    if (entry.initialized) return Promise.resolve()
    if (entry.state === 'disposed' || entry.state === 'disconnected' || entry.state === 'outcome-unknown') {
      return Promise.reject(new Error(`dsh-claude: session ${entry.sessionId} is ${entry.state}`))
    }
    return new Promise<void>((resolve, reject) => {
      entry.initWaiters.push(error => (error === undefined ? resolve() : reject(error instanceof Error ? error : new Error(String(error)))))
    })
  }

  async #metadataEntry(agent: Agent, model: string): Promise<SupervisorEntry> {
    const sessionId = agent.id as string
    let entry = this.#entries.get(sessionId)
    if (entry?.state === 'disposed' || entry?.state === 'disconnected' || entry?.state === 'outcome-unknown') {
      this.#entries.delete(sessionId)
      await this.#disposeEntry(entry)
      entry = undefined
    }
    if (entry === undefined) {
      await this.#makeRoom()
      entry = await this.#createEntry(agent, model)
      this.#entries.set(sessionId, entry)
      this.#armInitializationTimer(entry)
    }
    if (entry.ownerAgent !== agent) {
      throw new Error(`dsh-claude: live agent identity changed for session ${sessionId}`)
    }
    if (entry.active !== undefined || entry.state === 'interrupting') throw new ClaudeTurnBusyError(sessionId)
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    await this.#syncPermissionMode(entry)
    if (model !== entry.model) {
      await entry.query.setModel(model)
      entry.model = model
    }
    return entry
  }

  async #syncPermissionMode(entry: SupervisorEntry): Promise<void> {
    const mode = claudePermissionMode(entry.ownerAgent.session.events)
    if (mode === entry.permissionMode) return
    await entry.query.setPermissionMode(mode)
    entry.permissionMode = mode
  }

  async disposeSession(sessionId: string): Promise<void> {
    const entry = this.#entries.get(sessionId)
    if (entry === undefined) return
    this.#entries.delete(sessionId)
    await this.#disposeEntry(entry)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    await Promise.allSettled(entries.map(entry => this.#disposeEntry(entry)))
  }

  async #makeRoom(): Promise<void> {
    if (this.#entries.size < this.#config.maxProcesses) return
    const idle = [...this.#entries.values()]
      .filter(entry => entry.active === undefined && entry.state === 'idle')
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
    if (idle === undefined) throw new ClaudeProcessLimitError(this.#config.maxProcesses)
    this.#entries.delete(idle.sessionId)
    await this.#disposeEntry(idle)
  }

  async #createEntry(agent: Agent, model: string, thinkingMode?: ClaudeThinkingMode): Promise<SupervisorEntry> {
    const sessionId = agent.id as string
    const cwd = agent.session.header.cwd ?? process.cwd()
    const input = new AsyncQueue<SDKUserMessage>()
    const lifetime = new AbortController()
    const projection = await this.#sidecar.importLegacy(sessionId, agent.session.events)
    const binding = projection.binding
    const permissionMode = claudePermissionMode(agent.session.events)
    const entry = {
      sessionId,
      ownerAgent: agent,
      cwd,
      model,
      thinkingMode,
      permissionMode,
      state: 'starting' as ClaudeSupervisorState,
      lastUsedAt: Date.now(),
      input,
      lifetime,
      claudeSessionId: binding?.claudeSessionId,
      expectedResume: binding?.claudeSessionId,
      handshakeUuid: randomUUID(),
      handshakePending: true,
      initialized: false,
      initWaiters: [] as Array<(error: unknown) => void>,
      initTimer: undefined,
      idleTimer: undefined,
      tasks: new Map<string, ClaudeTaskInfo>(),
      taskSnapshotAt: 0,
      taskSnapshotTimer: undefined,
    } as SupervisorEntry

    const canUseTool = createPermissionBridge(this.#approval, () => {
      const active = entry.active
      return active === undefined ? undefined : {
        agent: active.agent,
        cursor: active.cursor,
        markActivity: () => { active.sawActivity = true },
        recordDenial: toolUseId => { active.deniedToolUseIds.add(toolUseId) },
        appendActivity: activity => this.#appendActivity(active, activity),
      }
    })
    const options: ClaudeOptions = {
      pathToClaudeCodeExecutable: this.#config.executablePath,
      cwd,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      permissionMode,
      allowDangerouslySkipPermissions: true,
      canUseTool,
      abortController: lifetime,
      spawnClaudeCodeProcess: createManagedClaudeSpawner(this.#runtime, this.#config.executablePath, process => {
        entry.process = process
      }),
      ...(binding === undefined ? {} : { resume: binding.claudeSessionId }),
      model,
      ...(thinkingMode === undefined
        ? {}
        : thinkingMode === 'off'
          ? { thinking: { type: 'disabled' } as const }
          : thinkingMode === 'ultracode'
            ? { settings: { ultracode: true } satisfies ClaudeSettings }
            : { effort: thinkingMode }),
    }
    entry.query = this.#queryFactory({ prompt: input, options })
    entry.input.push(sdkUserMessage(CLAUDE_HANDSHAKE_PROMPT, entry.handshakeUuid))
    entry.pump = this.#runDetached(() => this.#pump(entry))
    return entry
  }

  async #pump(entry: SupervisorEntry): Promise<void> {
    try {
      for await (const sdkMessage of entry.query) {
        for (const message of normalizeSdkMessage(sdkMessage as SDKMessage)) {
          await this.#handleMessage(entry, message)
        }
      }
      if (entry.state !== 'disposed') await this.#handleDisconnect(entry, new Error('Claude Code stream ended'))
    } catch (error) {
      if (entry.state !== 'disposed') await this.#handleDisconnect(entry, error)
    }
  }

  async #handleMessage(entry: SupervisorEntry, message: NormalizedSdkMessage): Promise<void> {
    if (message.kind === 'init') {
      // Claude Code can re-emit system/init across turns in long-lived
      // streaming-input mode (e.g. the auth-error path). Treat it idempotently:
      // refresh the session id/version and negotiated state, and only reject a
      // genuine identity/cwd mismatch.
      if (entry.expectedResume !== undefined && message.sessionId !== entry.expectedResume) {
        throw new ClaudeProtocolError(`Claude Code resumed unexpected session ${message.sessionId}; expected ${entry.expectedResume}`)
      }
      if (message.cwd !== entry.cwd) {
        throw new ClaudeProtocolError(`Claude Code initialized in unexpected cwd ${message.cwd}; expected ${entry.cwd}`)
      }
      if (entry.initTimer !== undefined) {
        clearTimeout(entry.initTimer)
        entry.initTimer = undefined
      }
      entry.initialized = true
      entry.claudeSessionId = message.sessionId
      entry.state = entry.active === undefined ? 'idle' : 'running'
      for (const waiter of entry.initWaiters.splice(0)) waiter(undefined)
      // The SDK emits no background-task level at startup; reset the board on
      // every (re)start and let membership changes repopulate it.
      if (entry.tasks.size > 0) {
        entry.tasks.clear()
        await this.#flushTasksSnapshot(entry)
      }
      await this.#sidecar.writeBinding(entry.sessionId, {
        claudeSessionId: message.sessionId,
        cliVersion: message.cliVersion,
        cwd: message.cwd,
      })
      return
    }

    // Task lifecycle is session-scoped, not turn-scoped: background tasks and
    // subagents settle while no DSH turn is active, and their notifications
    // must still reach the task board instead of being dropped with turn-less
    // messages below.
    const taskId = message.kind === 'subagent' ? message.taskId : undefined
    if (message.kind === 'subagent' && taskId !== undefined) {
      await this.#trackTask(entry, message, taskId, entry.active?.cursor.turn)
    } else if (message.kind === 'background-tasks') {
      this.#trackBackgroundLevel(entry, message.tasks, entry.active?.cursor.turn)
    }

    if (entry.handshakePending) {
      // Startup-handshake output of the local `/status` nudge: never part of
      // any DSH turn. Protocol failures stay loud; the settlement clears the
      // phase so subsequent messages belong to real turns.
      if (message.kind === 'protocol-error') {
        throw new ClaudeProtocolError(`${message.title}: ${JSON.stringify(message.detail).slice(0, 1_000)}`)
      }
      if (message.kind === 'result') entry.handshakePending = false
      return
    }

    const active = entry.active
    if (active === undefined) return
    if (message.kind === 'result') {
      if (message.userMessageUuid !== undefined && message.userMessageUuid === entry.handshakeUuid) {
        // Startup handshake settlement; never a DSH turn outcome.
        return
      }
      if (entry.claudeSessionId === undefined) {
        throw new ClaudeProtocolError('Claude Code sent a result before initialization')
      }
      if (message.sessionId !== entry.claudeSessionId) {
        throw new ClaudeProtocolError(`Claude Code result session ${message.sessionId} does not match ${entry.claudeSessionId}`)
      }
      if (message.userMessageUuid !== undefined && message.userMessageUuid !== active.promptUuid) {
        throw new ClaudeProtocolError(`Claude Code result for user message ${message.userMessageUuid} does not match active request ${active.promptUuid}`)
      }
      await this.#completeTurn(entry, active, message)
      return
    }
    if (message.kind === 'protocol-error') {
      throw new ClaudeProtocolError(`${message.title}: ${JSON.stringify(message.detail).slice(0, 1_000)}`)
    }
    active.sawActivity = true

    switch (message.kind) {
      case 'text-delta':
        if (message.parentToolUseId !== undefined) return
        active.sawTextDelta = true
        active.text += message.text
        active.output.push({ type: 'text-delta', text: message.text })
        return
      case 'assistant-text':
        if (message.parentToolUseId !== undefined) return
        if (!active.sawTextDelta) {
          // Complete assistant text is the fallback when no partial text delta
          // streamed. Mark text-delta seen so that additional complete
          // assistant records sharing the same message.id (one per completed
          // content block) do not duplicate the text.
          active.sawTextDelta = true
          active.text += message.text
          active.output.push({ type: 'text-delta', text: message.text })
        }
        return
      case 'thinking':
        if (message.parentToolUseId !== undefined) return
        if (message.phase === 'updated') {
          active.thinking += message.text
          return
        }
        active.thinking = message.text
        await this.#appendActivity(active, {
          kind: 'thinking',
          phase: 'completed',
          title: 'Claude thinking',
          summary: message.text,
        })
        return
      case 'tool-call':
        await this.#appendActivity(active, {
          kind: message.parentToolUseId === undefined ? 'tool-call' : 'subagent',
          phase: 'started',
          toolUseId: message.toolUseId,
          ...(message.parentToolUseId === undefined ? {} : { parentToolUseId: message.parentToolUseId }),
          toolName: message.toolName,
          title: message.toolName,
          summary: message.parentToolUseId === undefined ? rootCallSummary(message.toolName, message.input) : `Subagent called ${message.toolName}`,
          detail: message.input,
        })
        if (message.parentToolUseId === undefined) {
          active.callNames.set(message.toolUseId, message.toolName)
          this.#ensureDynamicPresenter(active.agent, message.toolName)
          // Task dispatches render as plugin-owned group cards gathering the
          // subagents' nested work; only ordinary tools mirror natively.
          if (!TASK_TOOL_NAMES.has(message.toolName)) await this.#appendNativeToolCall(active, message)
        }
        return
      case 'tool-result':
        await this.#appendActivity(active, {
          kind: message.parentToolUseId === undefined ? 'tool-result' : 'subagent',
          phase: message.isError ? 'failed' : 'completed',
          toolUseId: message.toolUseId,
          ...(message.parentToolUseId === undefined ? {} : { parentToolUseId: message.parentToolUseId }),
          title: message.isError ? 'Tool failed' : 'Tool completed',
          detail: message.output,
          isError: message.isError,
        })
        if (message.parentToolUseId === undefined
          && !TASK_TOOL_NAMES.has(active.callNames.get(message.toolUseId) ?? '')) {
          await this.#appendNativeToolResult(active, message)
        }
        return
      case 'subagent':
        await this.#appendActivity(active, {
          kind: 'subagent',
          phase: message.phase,
          ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
          title: message.title,
          summary: message.summary,
          detail: message.detail,
          isError: message.phase === 'failed',
        })
        return
      case 'status':
      case 'warning':
      case 'unknown':
        await this.#appendActivity(active, {
          kind: message.kind === 'status' ? 'status' : 'warning',
          phase: 'updated',
          title: message.title,
          ...('summary' in message ? { summary: message.summary } : {}),
          ...('detail' in message ? { detail: message.detail } : {}),
        })
        return
      case 'permission-denied':
        await this.#appendActivity(active, {
          kind: 'permission',
          phase: 'denied',
          toolUseId: message.toolUseId,
          toolName: message.toolName,
          title: message.toolName,
          summary: message.summary,
        })
        return
    }
  }

  /** Merge one task lifecycle message into the session's task board. */
  async #trackTask(
    entry: SupervisorEntry,
    message: Extract<NormalizedSdkMessage, { kind: 'subagent' }>,
    taskId: string,
    originTurn: number | undefined,
  ): Promise<void> {
    const previous = entry.tasks.get(taskId)
    const next: ClaudeTaskInfo = {
      taskId,
      description: message.description ?? previous?.description ?? message.title,
      status: message.taskStatus ?? previous?.status ?? 'running',
    }
    const resolvedOriginTurn = previous?.originTurn ?? originTurn
    if (resolvedOriginTurn !== undefined) next.originTurn = resolvedOriginTurn
    const subagentType = message.subagentType ?? previous?.subagentType
    if (subagentType !== undefined) next.subagentType = subagentType
    const taskType = message.taskType ?? previous?.taskType
    if (taskType !== undefined) next.taskType = taskType
    const lastToolName = message.lastToolName ?? previous?.lastToolName
    if (lastToolName !== undefined) next.lastToolName = lastToolName
    const summary = message.summary ?? previous?.summary
    if (summary !== undefined) next.summary = summary
    const usage = message.usage ?? previous?.usage
    if (usage !== undefined) next.usage = usage
    if (previous?.backgrounded === true) next.backgrounded = true
    entry.tasks.set(taskId, next)
    const settled = next.status !== 'running'
    await this.#scheduleTasksSnapshot(entry, settled)
  }

  /** Fold the background-task level signal into the board (REPLACE semantics
   *  for the backgrounded flag: only the listed tasks are detached). */
  #trackBackgroundLevel(
    entry: SupervisorEntry,
    tasks: readonly { taskId: string; taskType?: string; description: string }[],
    originTurn: number | undefined,
  ): void {
    const live = new Set(tasks.map(task => task.taskId))
    let changed = false
    for (const task of tasks) {
      const existing = entry.tasks.get(task.taskId)
      if (existing === undefined) {
        entry.tasks.set(task.taskId, {
          taskId: task.taskId,
          description: task.description,
          status: 'running',
          ...(originTurn === undefined ? {} : { originTurn }),
          ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
          backgrounded: true,
        })
        changed = true
      } else if (existing.backgrounded !== true || existing.status !== 'running') {
        entry.tasks.set(task.taskId, { ...existing, status: 'running', backgrounded: true })
        changed = true
      }
    }
    for (const task of entry.tasks.values()) {
      if (task.backgrounded === true && task.status === 'running' && !live.has(task.taskId)) {
        entry.tasks.set(task.taskId, { ...task, status: 'completed' })
        changed = true
      }
    }
    if (changed) void this.#scheduleTasksSnapshot(entry, true)
  }

  /** Persist the task board. Settled transitions flush immediately; progress
   *  ticks throttle to one snapshot per second to bound log volume. */
  async #scheduleTasksSnapshot(entry: SupervisorEntry, immediate: boolean): Promise<void> {
    const THROTTLE_MS = 1_000
    const elapsed = Date.now() - entry.taskSnapshotAt
    if (!immediate && elapsed < THROTTLE_MS) {
      if (entry.taskSnapshotTimer === undefined) {
        entry.taskSnapshotTimer = setTimeout(() => {
          entry.taskSnapshotTimer = undefined
          void this.#flushTasksSnapshot(entry)
        }, THROTTLE_MS - elapsed)
        entry.taskSnapshotTimer.unref?.()
      }
      return
    }
    await this.#flushTasksSnapshot(entry)
  }

  async #flushTasksSnapshot(entry: SupervisorEntry): Promise<void> {
    if (entry.taskSnapshotTimer !== undefined) {
      clearTimeout(entry.taskSnapshotTimer)
      entry.taskSnapshotTimer = undefined
    }
    entry.taskSnapshotAt = Date.now()
    // Snapshot persistence is best-effort: the in-memory board stays
    // authoritative and the next change re-flushes.
    await this.#sidecar.writeTasks(entry.sessionId, [...entry.tasks.values()]).catch(() => undefined)
  }

  async #completeTurn(
    entry: SupervisorEntry,
    active: ActiveTurn,
    result: Extract<NormalizedSdkMessage, { kind: 'result' }>,
  ): Promise<void> {
    if (entry.active !== active) return
    if (active.signal !== undefined && active.abortListener !== undefined) {
      active.signal.removeEventListener('abort', active.abortListener)
    }
    if (active.aborted) {
      await this.#appendSafely(active, {
        kind: 'status',
        phase: 'failed',
        title: 'Claude Code turn cancelled',
      })
      entry.active = undefined
      entry.state = 'idle'
      entry.lastUsedAt = Date.now()
      this.#armIdleTimer(entry)
      return
    }
    if (result.usage.inputTokens !== undefined || result.usage.outputTokens !== undefined || result.usage.cumulativeCostUsd !== undefined) {
      await this.#appendSafely(active, {
        kind: 'usage',
        phase: 'completed',
        title: 'Claude usage',
        summary: usageSummary(result.usage),
        usage: result.usage,
      })
      active.output.push({ type: 'usage', usage: result.usage })
    }
    const unmatchedDenials = (result.permissionDenials ?? [])
      .filter(denial => !active.deniedToolUseIds.has(denial.toolUseId))
    if (unmatchedDenials.length > 0) {
      await this.#appendSafely(active, {
        kind: 'permission',
        phase: 'denied',
        title: 'Claude Code auto-denied tool calls',
        summary: unmatchedDenials.map(denial => denial.toolName).join(', '),
      })
    }
    if (!result.success) {
      const message = result.errors?.join('\n')
        ?? (result.terminalReason !== undefined ? `Claude Code failed the turn (${result.terminalReason})` : 'Claude Code failed the turn')
      await this.#appendSafely(active, {
        kind: 'error',
        phase: 'failed',
        title: 'Claude Code turn failed',
        summary: message,
        isError: true,
      })
      active.output.fail(new Error(message))
    } else {
      if (!active.sawTextDelta && active.text.length === 0 && result.text !== undefined) {
        active.text = result.text
        active.output.push({ type: 'text-delta', text: result.text })
      }
      await this.#appendSafely(active, {
        kind: 'status',
        phase: 'completed',
        title: 'Claude Code turn completed',
      })
      active.output.push({ type: 'complete', text: active.text })
      active.output.close()
    }
    entry.active = undefined
    entry.state = 'idle'
    entry.lastUsedAt = Date.now()
    this.#armIdleTimer(entry)
  }

  async #appendActivity(active: ActiveTurn, activity: ClaudeActivityInput): Promise<void> {
    const ordinal = active.cursor.nextOrdinal++
    await this.#sidecar.appendActivity(active.agent.id as string, {
      ...activity,
      turn: active.cursor.turn,
      step: active.cursor.step,
      ordinal,
    })
  }

  /** Persist durable activity without letting a storage failure unsettle the
   * in-memory turn or leak process ownership. Audit failure is best-effort. */
  async #appendSafely(active: ActiveTurn, activity: ClaudeActivityInput): Promise<void> {
    await this.#appendActivity(active, activity).catch(() => undefined)
  }

  /** Register one presenter-only mirror for a tool name the static preset
   *  registry does not cover (MCP tools, newly added built-ins). Runs in the
   *  agent scope so the mirror is visible only to this preset's sessions and
   *  unwinds with the agent; failure keeps the generic card, never the turn. */
  #ensureDynamicPresenter(agent: Agent, name: string): void {
    if (CLAUDE_PRESENTER_NAMES.has(name)) return
    let known = this.#dynamicPresenterNames.get(agent)
    if (known === undefined) {
      known = new Set<string>()
      this.#dynamicPresenterNames.set(agent, known)
    }
    if (known.has(name)) return
    try {
      agent.ctx.tools.register(dynamicPresenterDefinition(name))
      known.add(name)
    } catch {
      // A late or disposed agent keeps the generic card; presentation must
      // never unsettle the Claude turn.
    }
  }

  /** Mirror one root Claude tool call into the durable native tool channel so
   *  the host's tool presentation renders it exactly like a DSH-executed call.
   *  Presentation duplication is best-effort and never unsettles the turn. */
  async #appendNativeToolCall(
    active: ActiveTurn,
    message: Extract<NormalizedSdkMessage, { kind: 'tool-call' }>,
  ): Promise<void> {
    try {
      await active.agent.session.append('tool/call', {
        turn: active.cursor.turn,
        step: active.cursor.step,
        callId: CallId(message.toolUseId),
        name: message.toolName,
        arguments: safeDetail(message.input) ?? '{}',
      })
    } catch {
      // Presentation duplication must never unsettle the Claude turn.
    }
  }

  async #appendNativeToolResult(
    active: ActiveTurn,
    message: Extract<NormalizedSdkMessage, { kind: 'tool-result' }>,
  ): Promise<void> {
    const text = typeof message.output === 'string' ? redactText(message.output) : safeDetail(message.output) ?? ''
    try {
      await active.agent.session.append('tool/result', {
        turn: active.cursor.turn,
        step: active.cursor.step,
        message: createToolResultMessage({
          callId: CallId(message.toolUseId),
          content: [{ type: 'text', text }],
          isError: message.isError,
        }),
      }, { surfaceOp: 'append' })
    } catch {
      // Presentation duplication must never unsettle the Claude turn.
    }
  }

  async #interrupt(entry: SupervisorEntry): Promise<void> {
    const active = entry.active
    if (active === undefined || entry.state === 'interrupting') return
    entry.state = 'interrupting'
    active.aborted = true
    active.output.fail(abortFailure())
    let interruptError: unknown
    try {
      const receipt = await withTimeout(entry.query.interrupt(), CLAUDE_INTERRUPT_TIMEOUT_MS, 'Claude Code interrupt')
      const queued = receipt?.still_queued ?? []
      if (queued.includes(active.promptUuid)) {
        throw new Error(`Claude Code interrupt left submitted prompt ${active.promptUuid} queued`)
      }
    } catch (error) {
      interruptError = error
    }
    try {
      await this.#appendActivity(active, {
        kind: 'status',
        phase: 'failed',
        title: interruptError === undefined ? 'Claude Code turn cancelled' : 'Claude Code cancelled; process entry reset',
        ...(interruptError === undefined ? {} : { summary: errorSummary(interruptError) }),
      })
    } catch {
      // The active output is already aborted; process cleanup cannot wait for audit availability.
    }
    if (this.#entries.get(entry.sessionId) === entry) this.#entries.delete(entry.sessionId)
    await this.#disposeEntry(entry)
  }

  async #handleDisconnect(entry: SupervisorEntry, error: unknown): Promise<void> {
    const active = entry.active
    const stderr = entry.process?.stderrTail()
    if (active !== undefined) {
      if (active.signal !== undefined && active.abortListener !== undefined) {
        active.signal.removeEventListener('abort', active.abortListener)
      }
      const unknown = active.sawActivity
      entry.state = unknown ? 'outcome-unknown' : 'disconnected'
      const failure = unknown
        ? new ClaudeOutcomeUnknownError(stderr === undefined || stderr.length === 0 ? undefined : `Claude Code exited after activity; outcome unknown. ${stderr}`)
        : new Error(stderr === undefined || stderr.length === 0 ? errorSummary(error) : stderr)
      await this.#appendSafely(active, {
        kind: 'error',
        phase: 'failed',
        title: unknown ? 'Claude Code outcome unknown' : 'Claude Code disconnected',
        summary: failure.message,
        isError: true,
        detail: error,
      })
      active.output.fail(failure)
      entry.active = undefined
    } else {
      entry.state = 'disconnected'
    }
    const waiters = entry.initWaiters.splice(0)
    const waiterError = error instanceof Error ? error : new Error(String(error))
    for (const waiter of waiters) waiter(waiterError)
    this.#entries.delete(entry.sessionId)
    await this.#disposeEntry(entry)
  }

  #armInitializationTimer(entry: SupervisorEntry): void {
    const timer = setTimeout(() => {
      if (entry.state !== 'starting' || entry.initialized) return
      void this.#handleDisconnect(entry, new Error('Claude Code initialization timed out'))
    }, CLAUDE_INITIALIZATION_TIMEOUT_MS)
    timer.unref?.()
    entry.initTimer = timer
  }

  #armIdleTimer(entry: SupervisorEntry): void {
    if (this.#config.idleTimeoutMs <= 0) return
    const timer = setTimeout(() => {
      if (entry.active !== undefined || entry.state !== 'idle') return
      this.#entries.delete(entry.sessionId)
      void this.#disposeEntry(entry)
    }, this.#config.idleTimeoutMs)
    timer.unref?.()
    entry.idleTimer = timer
  }

  async #disposeEntry(entry: SupervisorEntry): Promise<void> {
    if (entry.state === 'disposed') return
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    if (entry.initTimer !== undefined) clearTimeout(entry.initTimer)
    entry.state = 'disposed'
    entry.input.discard(abortFailure())
    entry.query.close()
    entry.lifetime.abort()
    if (entry.active !== undefined) entry.active.output.fail(abortFailure())
    entry.process?.kill('SIGTERM')
    if (entry.process !== undefined) {
      try {
        await entry.process.handle.waitForExit(AbortSignal.timeout(5_000))
      } catch {
        // The DSH subprocess owner still holds the tree and will finish escalation.
      }
    }
  }
}
