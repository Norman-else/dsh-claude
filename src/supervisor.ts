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
import type { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { AsyncQueue } from './async-queue.ts'
import { DEFAULT_CLAUDE_RENDER_MODE, TASK_TOOL_NAMES, type ClaudeRenderMode } from './constants.ts'
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
import { createUserQuestionBridge } from './user-question.ts'
import { ClaudeSidecarRepository } from './sidecar.ts'
import { CLAUDE_PRESENTER_NAMES, dynamicPresenterDefinition } from './presenters.ts'
import { normalizeSdkMessage, type NormalizedSdkMessage } from './sdk-messages.ts'
import { readPlanUsageFrom } from './plan-usage.ts'
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
  /** Which renderer the visible turn is produced for; read per message so a
   *  Settings change lands on the next turn without a Host restart. */
  renderMode?: ClaudeRenderMode
}

export type ClaudeTurnStreamEvent =
  | { type: 'text-delta'; text: string }
  /** One settled Claude thinking block, forwarded only for the native
   *  renderer, which draws it as a DSH reasoning block. */
  | { type: 'thinking'; text: string }
  | { type: 'usage'; usage: ClaudeUsage }
  | { type: 'segment-complete'; text: string }
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
  prompt: SDKUserMessage['message']['content']
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
  phase: 'primary' | 'waiting-tasks' | 'follow-up'
  sawActivity: boolean
  sawTextDelta: boolean
  text: string
  /** Visible prose for the current top-level assistant segment. */
  transcriptText: string
  /** Stable sidecar ordinal reused while the current assistant segment grows. */
  transcriptTextOrdinal: number | undefined
  thinking: string
  /** Newest single-call prompt accounting; what DSH's context meter divides. */
  requestUsage: ClaudeUsage | undefined
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
  /** Official SDK initialization control request; no stdin nudge is required. */
  sdkInitialization: Promise<void>
  lifetime: AbortController
  process: ManagedClaudeProcess | undefined
  claudeSessionId: string | undefined
  active: ActiveTurn | undefined
  idleTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether the message stream has emitted system/init for session binding. */
  initialized: boolean
  expectedResume: string | undefined
  /** Newest main-chain entry uuid Claude emitted; the anchor a rewind of the
   *  next turn forks at. Sidechain (subagent) entries are not chain entries. */
  lastChainUuid: string | undefined
  /** Whether this process consumed an armed rewind fork target at spawn. */
  consumedRewind: boolean
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

/** The uuid of one main-chain transcript entry, or undefined for anything a
 *  rewind must not fork at: stream partials, results, and sidechain traffic. */
function chainEntryUuid(message: SDKMessage): string | undefined {
  if (message.type !== 'assistant' && message.type !== 'user') return undefined
  const envelope = message as { uuid?: unknown; parent_tool_use_id?: unknown }
  if (typeof envelope.parent_tool_use_id === 'string') return undefined
  return typeof envelope.uuid === 'string' && envelope.uuid.length > 0 ? envelope.uuid : undefined
}

function sdkUserMessage(prompt: SDKUserMessage['message']['content'], uuid: ReturnType<typeof randomUUID>): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    uuid,
  }
}

const BACKGROUND_TASK_REPORT_PROMPT = [
  'The background tasks launched by your preceding response have now all settled.',
  'Report their final completed or failed outcomes concisely to the user.',
  'Do not start new tools or tasks, and do not repeat the earlier progress update.',
].join(' ')

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
  readonly #interruptions = new Map<string, Promise<void>>()
  readonly #runtime: Pick<SubprocessRuntime, 'spawn'>
  readonly #approval: Pick<ApprovalService, 'request'>
  readonly #userQuestions: Pick<UserQuestionService, 'ask'>
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
    userQuestions: Pick<UserQuestionService, 'ask'>
    config: ClaudeSupervisorConfig
    queryFactory?: ClaudeQueryFactory
    runDetached?: <T>(operation: () => T) => T
    sidecar?: ClaudeSidecarRepository
  }) {
    this.#runtime = dependencies.runtime
    this.#approval = dependencies.approval
    this.#userQuestions = dependencies.userQuestions
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
    this.#recordContextWindow(model, usage)
    return usage
  }

  /** Cache a window under both the selector id the caller asked for and the
   *  concrete model the CLI reports, so either name resolves it later. */
  #recordContextWindow(model: string, usage: SDKControlGetContextUsageResponse): void {
    const contextWindow = usage.rawMaxTokens > 0 ? usage.rawMaxTokens : usage.maxTokens
    if (contextWindow <= 0) return
    this.#contextWindows.set(model, contextWindow)
    this.#contextWindows.set(usage.model, contextWindow)
  }

  /** Learn a model's context window the first time a turn finishes on it.
   *
   *  DSH hides its context meter entirely unless the route publishes a
   *  capacity, and these numbers move with Claude releases — so none are
   *  hardcoded; the CLI is asked over the session's own live process.
   *
   *  Turn completion is the earliest honest moment to ask. `entry.model` is
   *  already the model that just ran, so no model switch is provoked — which
   *  rules out asking from `resolveModel`, since DSH resolves every model in
   *  the catalog to build its picker and `#metadataEntry` would switch the live
   *  session once per entry. And nothing is lost by waiting: the meter needs a
   *  usage sample too, and no turn has reported one before the first turn ends.
   *
   *  Best-effort — a failure leaves the window unknown (the meter stays hidden,
   *  exactly as before) and the next completed turn tries again. */
  async #learnContextWindow(entry: SupervisorEntry): Promise<void> {
    if (this.#contextWindows.has(entry.model)) return
    try {
      const usage = await withTimeout(
        entry.query.getContextUsage(),
        CLAUDE_METADATA_TIMEOUT_MS,
        'Claude context window probe',
      )
      this.#recordContextWindow(entry.model, usage)
    } catch {
      // Intentionally silent: this is opportunistic chrome, never turn-critical.
    }
  }

  contextWindow(model: string): number | undefined {
    return this.#contextWindows.get(model)
  }

  /** Raw `/usage` payload, read over a session's existing process. Only the
   *  idle-time metadata bridge uses this; a user-triggered refresh runs
   *  probePlanUsage instead so it never waits on, or perturbs, a session. */
  planUsage(agent: Agent, model = this.#config.defaultModel): Promise<unknown> {
    return this.#runMetadata(agent, model, query => readPlanUsageFrom(query))
  }

  runTurn(request: ClaudeTurnRequest): Promise<AsyncIterable<ClaudeTurnStreamEvent>> {
    const interruption = this.#interruptions.get(request.agent.id as string)
    if (interruption !== undefined) return interruption.then(() => this.runTurn(request))
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
    }
    if (entry.ownerAgent !== request.agent) {
      throw new Error(`dsh-claude: live agent identity changed for session ${sessionId}`)
    }
    if (entry.active !== undefined || entry.state === 'interrupting') throw new ClaudeTurnBusyError(sessionId)
    await entry.sdkInitialization

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
      await entry.sdkInitialization
    } else {
      await this.#syncPermissionMode(entry)
      if (model !== entry.model) {
        await this.#control(entry, entry.query.setModel(model), 'Claude Code model switch')
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
      phase: 'primary',
      sawActivity: false,
      sawTextDelta: false,
      text: '',
      transcriptText: '',
      transcriptTextOrdinal: undefined,
      thinking: '',
      requestUsage: undefined,
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
      const abortListener = () => { void this.#startInterrupt(entry as SupervisorEntry) }
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
        // Use the SDK's initialize control request. system/init is emitted only
        // after the first real stdin message and is reserved for session binding.
        await entry.sdkInitialization
        return await this.#control(entry, operation(entry.query, entry), 'Claude metadata request')
      } finally {
        entry.lastUsedAt = Date.now()
        if (entry.active === undefined && entry.state === 'idle') this.#armIdleTimer(entry)
      }
    })
    this.#admissionGate = admitted.then(() => undefined, () => undefined)
    return admitted
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
      await this.#control(entry, entry.query.setModel(model), 'Claude Code model switch')
      entry.model = model
    }
    return entry
  }

  /** Run one SDK control request against a live entry, and discard the entry if
   *  it does not answer.
   *
   *  Turn admission and every metadata read share one process-wide gate, so an
   *  unbounded control request stalls every session until the Host restarts.
   *  Bounding it is only half the cure: a timeout also proves this query has
   *  stopped answering, and keeping the entry means the next caller reuses the
   *  same dead process — timing out again, forever. Discarding it lets the next
   *  attempt spawn a fresh one. Every control request goes through here so a
   *  new call site cannot quietly reintroduce either half. */
  async #control<T>(
    entry: SupervisorEntry,
    operation: Promise<T>,
    label: string,
    timeoutMs = CLAUDE_METADATA_TIMEOUT_MS,
  ): Promise<T> {
    try {
      return await withTimeout(operation, timeoutMs, label)
    } catch (error) {
      if (this.#entries.get(entry.sessionId) === entry) this.#entries.delete(entry.sessionId)
      await this.#disposeEntry(entry)
      throw error
    }
  }

  async #syncPermissionMode(entry: SupervisorEntry): Promise<void> {
    const mode = claudePermissionMode(entry.ownerAgent.session.events)
    if (mode === entry.permissionMode) return
    await this.#control(entry, entry.query.setPermissionMode(mode), 'Claude Code permission mode switch')
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
    // A rewound session resumes at the kept turn's chain anchor, or drops its
    // binding entirely when the rewind discarded every turn. The truncating
    // resume may land in a different Claude session id, so the identity guard
    // stands down for exactly this spawn and re-binds from system/init.
    const pendingRewind = projection.rewind?.pending
    const forkAt = pendingRewind !== undefined && 'resumeAt' in pendingRewind ? pendingRewind.resumeAt : undefined
    const startFresh = pendingRewind !== undefined && 'fresh' in pendingRewind
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
      claudeSessionId: startFresh ? undefined : binding?.claudeSessionId,
      expectedResume: startFresh || forkAt !== undefined ? undefined : binding?.claudeSessionId,
      lastChainUuid: undefined,
      consumedRewind: pendingRewind !== undefined,
      initialized: false,
      idleTimer: undefined,
      tasks: new Map<string, ClaudeTaskInfo>(),
      taskSnapshotAt: 0,
      taskSnapshotTimer: undefined,
    } as SupervisorEntry

    const activeInteraction = () => {
      const active = entry.active
      return active === undefined ? undefined : {
        agent: active.agent,
        cursor: active.cursor,
        markActivity: () => { active.sawActivity = true },
        recordDenial: (toolUseId: string) => { active.deniedToolUseIds.add(toolUseId) },
        hasFullAccess: async () => {
          await this.#syncPermissionMode(entry)
          return entry.permissionMode === 'bypassPermissions'
        },
        appendActivity: (activity: ClaudeActivityInput) => this.#appendActivity(active, activity),
      }
    }
    const userQuestion = createUserQuestionBridge(this.#userQuestions, activeInteraction)
    const canUseTool = createPermissionBridge(this.#approval, activeInteraction, userQuestion)
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
      ...(binding === undefined || startFresh ? {} : {
        resume: binding.claudeSessionId,
        ...(forkAt === undefined ? {} : { resumeSessionAt: forkAt }),
      }),
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
    entry.pump = this.#runDetached(() => this.#pump(entry))
    entry.sdkInitialization = withTimeout(
      entry.query.initializationResult(),
      CLAUDE_INITIALIZATION_TIMEOUT_MS,
      'Claude SDK initialization',
    ).then(() => {
      if (entry.state === 'starting') entry.state = 'idle'
    })
    void entry.sdkInitialization.catch(error => this.#handleDisconnect(entry, error))
    return entry
  }

  async #pump(entry: SupervisorEntry): Promise<void> {
    try {
      for await (const sdkMessage of entry.query) {
        const chainUuid = chainEntryUuid(sdkMessage as SDKMessage)
        if (chainUuid !== undefined) entry.lastChainUuid = chainUuid
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
      const firstInitialization = !entry.initialized
      if (entry.expectedResume !== undefined && message.sessionId !== entry.expectedResume) {
        throw new ClaudeProtocolError(`Claude Code resumed unexpected session ${message.sessionId}; expected ${entry.expectedResume}`)
      }
      if (message.cwd !== entry.cwd) {
        throw new ClaudeProtocolError(`Claude Code initialized in unexpected cwd ${message.cwd}; expected ${entry.cwd}`)
      }
      entry.initialized = true
      entry.claudeSessionId = message.sessionId
      entry.state = entry.active === undefined ? 'idle' : 'running'
      // A newly created Query cannot retain tasks from the previous process,
      // but repeated init messages from this same long-lived Query are only
      // protocol refreshes and must not erase background work still running.
      if (firstInitialization && entry.tasks.size > 0) {
        entry.tasks.clear()
        await this.#flushTasksSnapshot(entry)
      }
      await this.#sidecar.writeBinding(entry.sessionId, {
        claudeSessionId: message.sessionId,
        cliVersion: message.cliVersion,
        cwd: message.cwd,
      })
      // The fork target is spent the moment Claude resumes at it; leaving it
      // armed would re-truncate the session on the next respawn.
      if (entry.consumedRewind) {
        entry.consumedRewind = false
        await this.#sidecar.clearRewindPending(entry.sessionId)
      }
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
      await this.#trackBackgroundLevel(entry, message.tasks, entry.active?.cursor.turn)
    }

    const active = entry.active
    if (active === undefined) return
    if (message.kind === 'result') {
      if (entry.claudeSessionId === undefined) {
        throw new ClaudeProtocolError('Claude Code sent a result before initialization')
      }
      if (message.sessionId !== entry.claudeSessionId) {
        throw new ClaudeProtocolError(`Claude Code result session ${message.sessionId} does not match ${entry.claudeSessionId}`)
      }
      if (active.phase === 'waiting-tasks') {
        // The CLI may automatically react to each completed background task and
        // emit a top-level result, correlated or not. Publish that prose as a
        // completed progress block, but keep the original DSH turn open until
        // every owned task settles and the explicit final report returns.
        await this.#completeProgressSegment(active, message)
        return
      }
      if (message.userMessageUuid !== undefined && message.userMessageUuid !== active.promptUuid) {
        // A stale internal continuation must not settle the explicit final
        // report request. Primary-turn mismatches remain protocol failures.
        if (active.phase === 'follow-up') return
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
        active.transcriptText += message.text
        await this.#upsertTranscriptText(active)
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
          active.transcriptText += message.text
          await this.#upsertTranscriptText(active)
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
        // The plugin transcript reads thinking off the sidecar; the native
        // renderer needs it on the stream to build a reasoning block.
        if (this.#nativeRendering()) active.output.push({ type: 'thinking', text: message.text })
        return
      case 'tool-call':
        if (message.parentToolUseId === undefined) this.#closeTranscriptTextSegment(active)
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
          // Only root calls are mirrored: a subagent's nested tools belong to
          // the Task card that dispatched them, and the native channel has no
          // nesting to hang them under.
          if (this.#nativeRendering()) {
            this.#ensureDynamicPresenter(active.agent, message.toolName)
            await this.#appendNativeToolCall(active, message)
          }
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
        if (message.parentToolUseId === undefined && this.#nativeRendering()) {
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
      case 'request-usage':
        // A subagent call bills against its own context, so it never stands in
        // for the main conversation's size.
        if (message.parentToolUseId === undefined) active.requestUsage = message.usage
        return
      case 'compaction':
        // Close the open prose span first: compaction sits *between* what was
        // said before and after it, never inside one text segment.
        this.#closeTranscriptTextSegment(active)
        await this.#appendActivity(active, {
          kind: 'compaction',
          phase: 'completed',
          title: 'Claude compacted the conversation',
          detail: {
            ...(message.trigger === undefined ? {} : { trigger: message.trigger }),
            ...(message.preTokens === undefined ? {} : { preTokens: message.preTokens }),
            ...(message.postTokens === undefined ? {} : { postTokens: message.postTokens }),
            ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
          },
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
        // A denied call never produces a tool result, so the native card would
        // stay pending forever. Settle it as the failure it is.
        if (this.#nativeRendering()) {
          await this.#appendNativeToolResult(active, {
            kind: 'tool-result',
            toolUseId: message.toolUseId,
            output: message.summary,
            isError: true,
          })
        }
        return
    }
  }

  #nativeRendering(): boolean {
    return (this.#config.renderMode ?? DEFAULT_CLAUDE_RENDER_MODE) === 'native'
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
    message: Pick<Extract<NormalizedSdkMessage, { kind: 'tool-result' }>, 'kind' | 'toolUseId' | 'output' | 'isError'>,
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
    if (settled) await this.#continueAfterTasks(entry)
  }

  /** Fold the background-task level signal into the board (REPLACE semantics
   *  for the backgrounded flag: only the listed tasks are detached). */
  async #trackBackgroundLevel(
    entry: SupervisorEntry,
    tasks: readonly { taskId: string; taskType?: string; description: string }[],
    originTurn: number | undefined,
  ): Promise<void> {
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
    if (changed) {
      await this.#scheduleTasksSnapshot(entry, true)
      await this.#continueAfterTasks(entry)
    }
  }

  #hasRunningTasks(entry: SupervisorEntry, active: ActiveTurn): boolean {
    return [...entry.tasks.values()].some(task => (
      task.originTurn === active.cursor.turn && task.backgrounded === true && task.status === 'running'
    ))
  }

  async #continueAfterTasks(entry: SupervisorEntry): Promise<void> {
    const active = entry.active
    if (active === undefined || active.phase !== 'waiting-tasks' || this.#hasRunningTasks(entry, active)) return
    active.phase = 'follow-up'
    active.promptUuid = randomUUID()
    active.sawTextDelta = false
    active.text = ''
    this.#closeTranscriptTextSegment(active)
    active.thinking = ''
    await this.#appendSafely(active, {
      kind: 'status',
      phase: 'updated',
      title: 'Claude Code is reporting background task results',
    })
    entry.input.push(sdkUserMessage(BACKGROUND_TASK_REPORT_PROMPT, active.promptUuid))
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

  /** What DSH is told about token usage: newest call's prompt, whole turn's output.
   *
   *  `TokenUsage` is documented as "token accounting for ONE model call", and
   *  DSH's token meter divides `uncachedInput + cacheRead + cacheWrite` by the
   *  context window to draw context pressure. One Claude turn makes many calls
   *  and the CLI's result usage sums all of them, so reporting that sum pinned
   *  the meter at 100%: a 35-call turn reads the same prompt from cache 35
   *  times, which sums past the window without the conversation ever growing.
   *  The newest single call answers "how big is this conversation now".
   *
   *  Output is deliberately excluded from that pressure sum, so the same
   *  argument never applied to it — and taking it from the newest call reported
   *  whatever the wrap-up message happened to cost, which is a couple of tokens
   *  after a turn that wrote thousands. The turn total is the honest figure.
   *
   *  The sidecar activity keeps the whole turn total for both — that is the
   *  audit and cost record, and nothing divides it by a window. */
  #reportedUsage(
    active: ActiveTurn,
    result: Extract<NormalizedSdkMessage, { kind: 'result' }>,
  ): ClaudeUsage {
    const prompt = active.requestUsage
    if (prompt === undefined) return result.usage
    return {
      ...prompt,
      ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
    }
  }

  async #completeProgressSegment(
    active: ActiveTurn,
    result: Extract<NormalizedSdkMessage, { kind: 'result' }>,
    recordUsage = true,
  ): Promise<void> {
    if (recordUsage && (result.usage.inputTokens !== undefined || result.usage.outputTokens !== undefined || result.usage.cumulativeCostUsd !== undefined)) {
      await this.#appendSafely(active, {
        kind: 'usage',
        phase: 'completed',
        title: 'Claude usage',
        summary: usageSummary(result.usage),
        usage: result.usage,
      })
      active.output.push({ type: 'usage', usage: this.#reportedUsage(active, result) })
    }
    if (!active.sawTextDelta && active.text.length === 0 && result.text !== undefined) {
      active.text = result.text
      active.transcriptText = result.text
      await this.#upsertTranscriptText(active)
      active.output.push({ type: 'text-delta', text: result.text })
    }
    await this.#upsertTranscriptText(active)
    active.output.push({ type: 'segment-complete', text: active.text })
    active.sawTextDelta = false
    active.text = ''
    this.#closeTranscriptTextSegment(active)
    active.thinking = ''
  }

  async #completeTurn(
    entry: SupervisorEntry,
    active: ActiveTurn,
    result: Extract<NormalizedSdkMessage, { kind: 'result' }>,
  ): Promise<void> {
    if (entry.active !== active) return
    if (active.aborted) {
      await this.#upsertTranscriptText(active)
      await this.#flushTranscript(active)
      await this.#appendSafely(active, {
        kind: 'status',
        phase: 'failed',
        title: 'Claude Code turn cancelled',
      })
      entry.active = undefined
      entry.state = 'idle'
      entry.lastUsedAt = Date.now()
      await this.#recordChainAnchor(entry, active)
      this.#checkpointProjection(entry)
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
      active.output.push({ type: 'usage', usage: this.#reportedUsage(active, result) })
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
      if (!active.sawTextDelta && active.text.length === 0 && result.text !== undefined) {
        active.text = result.text
        active.transcriptText = result.text
        await this.#upsertTranscriptText(active)
        active.output.push({ type: 'text-delta', text: result.text })
      }
      await this.#upsertTranscriptText(active)
      await this.#flushTranscript(active)
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
        active.transcriptText = result.text
        await this.#upsertTranscriptText(active)
        active.output.push({ type: 'text-delta', text: result.text })
      }
      await this.#upsertTranscriptText(active)
      if (active.phase === 'primary' && this.#hasRunningTasks(entry, active)) {
        active.phase = 'waiting-tasks'
        await this.#appendSafely(active, {
          kind: 'status',
          phase: 'updated',
          title: 'Claude Code is waiting for background tasks',
        })
        await this.#completeProgressSegment(active, result, false)
        return
      }
      await this.#appendSafely(active, {
        kind: 'status',
        phase: 'completed',
        title: 'Claude Code turn completed',
      })
      await this.#flushTranscript(active)
      active.output.push({ type: 'complete', text: active.text })
      active.output.close()
    }
    if (active.signal !== undefined && active.abortListener !== undefined) {
      active.signal.removeEventListener('abort', active.abortListener)
    }
    entry.active = undefined
    entry.state = 'idle'
    entry.lastUsedAt = Date.now()
    await this.#recordChainAnchor(entry, active)
    await this.#learnContextWindow(entry)
    this.#checkpointProjection(entry)
    this.#armIdleTimer(entry)
  }

  /** Tell every reader where this session's delta stream ended.
   *
   *  A reader that lost the turn's last delta has nothing later to reveal the
   *  hole, and a settled turn produces nothing further -- so a finished tool
   *  group would keep pulsing until the session was reopened by hand. Last
   *  line of the turn, best effort: presentation must never unsettle it. */
  #checkpointProjection(entry: SupervisorEntry): void {
    try {
      this.#sidecar.checkpoint(entry.sessionId)
    } catch {
      // A reader that misses the checkpoint is no worse off than before it.
    }
  }

  /** Pin where Claude's chain ended for the DSH turn that just settled, so a
   *  later rewind of the following turn can fork exactly here. Best effort:
   *  a missing anchor only makes a rewind fall back to an earlier turn. */
  async #recordChainAnchor(entry: SupervisorEntry, active: ActiveTurn): Promise<void> {
    const uuid = entry.lastChainUuid
    if (uuid === undefined) return
    try {
      await this.#sidecar.recordRewindAnchor(entry.sessionId, active.cursor.turn, uuid)
    } catch {
      // The sidecar is advisory; a failed anchor never fails the turn.
    }
  }

  async #upsertTranscriptText(active: ActiveTurn): Promise<void> {
    if (active.transcriptText.length === 0) return
    const ordinal = active.transcriptTextOrdinal ?? active.cursor.nextOrdinal++
    active.transcriptTextOrdinal = ordinal
    try {
      // Hot path: notify live subscribers synchronously; disk persistence is
      // coalesced inside the repository and flushed at segment/turn edges.
      this.#sidecar.appendTranscriptText(active.agent.id as string, {
        text: active.transcriptText,
        ...(this.#nativeRendering() ? { renderer: 'native' as const } : {}),
        turn: active.cursor.turn,
        step: active.cursor.step,
        ordinal,
      })
    } catch {
      // Transcript persistence is presentational and must not change a Claude outcome.
    }
  }

  async #flushTranscript(active: ActiveTurn): Promise<void> {
    await this.#sidecar.flushTranscriptText(active.agent.id as string).catch(() => undefined)
  }

  #closeTranscriptTextSegment(active: ActiveTurn): void {
    void this.#flushTranscript(active)
    active.transcriptText = ''
    active.transcriptTextOrdinal = undefined
  }

  async #appendActivity(active: ActiveTurn, activity: ClaudeActivityInput): Promise<void> {
    const ordinal = active.cursor.nextOrdinal++
    await this.#sidecar.appendActivity(active.agent.id as string, {
      ...activity,
      // Stamp the renderer this record was produced for. The Client reads it
      // back per step, so a step drawn natively is never also drawn by the
      // plugin transcript -- and history keeps whichever renderer produced it.
      ...(this.#nativeRendering() ? { renderer: 'native' as const } : {}),
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

  #startInterrupt(entry: SupervisorEntry): Promise<void> {
    const existing = this.#interruptions.get(entry.sessionId)
    if (existing !== undefined) return existing
    const interruption = this.#interrupt(entry).finally(() => {
      this.#interruptions.delete(entry.sessionId)
    })
    this.#interruptions.set(entry.sessionId, interruption)
    return interruption
  }

  async #interrupt(entry: SupervisorEntry): Promise<void> {
    const active = entry.active
    if (active === undefined || entry.state === 'interrupting') return
    entry.state = 'interrupting'
    active.aborted = true
    active.output.fail(abortFailure())
    await this.#upsertTranscriptText(active)
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
      await this.#upsertTranscriptText(active)
      await this.#flushTranscript(active)
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
    this.#entries.delete(entry.sessionId)
    await this.#disposeEntry(entry)
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
