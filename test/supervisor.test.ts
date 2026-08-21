import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Options as ClaudeOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AsyncQueue } from '../src/async-queue.ts'
import { ClaudeSidecarRepository } from '../src/sidecar.ts'
import type { ClaudeActivityInput } from '../src/events.ts'
import {
  ClaudeOutcomeUnknownError,
  ClaudeProcessLimitError,
  ClaudeSupervisor,
  ClaudeTurnBusyError,
  claudePermissionMode,
  type ClaudeQueryFactory,
  type ClaudeTurnStreamEvent,
} from '../src/supervisor.ts'

class FakeQuery extends AsyncQueue<SDKMessage> {
  readonly interrupt = vi.fn(async () => undefined)
  readonly setModel = vi.fn(async () => undefined)
  readonly setPermissionMode = vi.fn(async () => undefined)
  readonly supportedCommands = vi.fn(async () => [
    { name: 'review', description: 'Review changes', argumentHint: '<path>' },
  ])
  readonly getContextUsage = vi.fn(async () => ({
    categories: [{ name: 'Messages', tokens: 120, color: '#3b82f6' }],
    totalTokens: 120,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 0,
    gridRows: [],
    model: 'claude-test',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  }))
  readonly options: ClaudeOptions
  readonly input: AsyncIterable<SDKUserMessage>
  #handshakeSettled = false

  constructor(input: AsyncIterable<SDKUserMessage>, options: ClaudeOptions) {
    super()
    this.input = input
    this.options = options
  }

  /** Mirror the real CLI: the startup `/status` handshake settles right
   *  after the first init, before any real turn output. */
  override push(message: SDKMessage): void {
    super.push(message)
    const record = message as unknown as { type?: string; subtype?: string; session_id?: string }
    if (!this.#handshakeSettled && record.type === 'system' && record.subtype === 'init') {
      this.#handshakeSettled = true
      super.push({
        type: 'result',
        subtype: 'success',
        session_id: record.session_id ?? 'claude-session-1',
        result: '',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as SDKMessage)
    }
  }
}

function factory() {
  const queries: FakeQuery[] = []
  const create: ClaudeQueryFactory = ({ prompt, options }) => {
    const fake = new FakeQuery(prompt, options)
    queries.push(fake)
    return fake as unknown as Query
  }
  return { create, queries }
}

function fakeAgent(id = 'dsh-session-1', cwd = '/workspace', onAppend?: (type: string, data: unknown) => void) {
  const events: Array<{ type: string; data: unknown; seq: number; time: number }> = [
    { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
    { type: 'step/start', data: { turn: 1, step: 1 }, seq: 1, time: 2 },
  ]
  let appendError: unknown
  const session = {
    header: { cwd },
    get events() { return events },
    append: async (type: string, data: unknown) => {
      onAppend?.(type, data)
      if (appendError !== undefined) throw appendError
      const event = { type, data, seq: events.length, time: Date.now() }
      events.push(event)
      return event
    },
  }
  const registeredTools: string[] = []
  const agent = {
    id,
    session,
    ctx: {
      tools: {
        register: (definition: { name: string }) => {
          registeredTools.push(definition.name)
          return () => undefined
        },
      },
    },
    failAppend: (error: unknown) => { appendError = error },
  } as unknown as Agent & { failAppend(error: unknown): void }
  return { agent, events, registeredTools }
}

const sidecarRoots: string[] = []
const sidecars = new WeakMap<ClaudeSupervisor, ClaudeSidecarRepository>()

afterEach(async () => {
  await Promise.all(sidecarRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function supervisor(
  create: ClaudeQueryFactory,
  maxProcesses = 4,
  idleTimeoutMs = 60_000,
  suppliedSidecar?: ClaudeSidecarRepository,
) {
  const root = join(tmpdir(), `dsh-claude-supervisor-${randomUUID()}`)
  sidecarRoots.push(root)
  const sidecar = suppliedSidecar ?? new ClaudeSidecarRepository({ root })
  const runtime = new ClaudeSupervisor({
    runtime: { spawn: () => { throw new Error('fake query must not spawn') } },
    approval: { request: async () => 'rejected' },
    userQuestions: { ask: async () => ({ answers: [] }) },
    config: {
      executablePath: '/local/claude',
      idleTimeoutMs,
      maxProcesses,
      defaultModel: 'default',
    },
    queryFactory: create,
    sidecar,
  })
  sidecars.set(runtime, sidecar)
  return runtime
}

function projection(runtime: ClaudeSupervisor, sessionId = 'dsh-session-1') {
  return sidecars.get(runtime)!.read(sessionId)
}

class HookedSidecar extends ClaudeSidecarRepository {
  readonly #beforeAppend: (activity: ClaudeActivityInput) => void

  constructor(root: string, beforeAppend: (activity: ClaudeActivityInput) => void) {
    super({ root })
    this.#beforeAppend = beforeAppend
  }

  override appendActivity(sessionId: string, activity: ClaudeActivityInput & { turn: number; step: number; ordinal: number }) {
    this.#beforeAppend(activity)
    return super.appendActivity(sessionId, activity)
  }
}

const init = (sessionId = 'claude-session-1') => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  claude_code_version: '2.1.233',
  cwd: '/workspace',
}) as SDKMessage

const delta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
}) as SDKMessage

const result = (text = 'hello', sessionId = 'claude-session-1') => ({
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  result: text,
  total_cost_usd: 0.01,
  usage: { input_tokens: 4, output_tokens: 2 },
}) as SDKMessage

const toolCallMessage = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls -la' } }],
  },
} as SDKMessage

const toolResultMessage = {
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'listed' }],
  },
  tool_use_result: 'listed',
} as SDKMessage

async function collect(stream: AsyncIterable<ClaudeTurnStreamEvent>): Promise<ClaudeTurnStreamEvent[]> {
  const events: ClaudeTurnStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('DSH access mode mapping', () => {
  it.each([
    ['read-only', 'plan'],
    ['workspace-write', 'acceptEdits'],
    ['danger-full-access', 'bypassPermissions'],
  ] as const)('maps %s to Claude %s', (sandboxMode, permissionMode) => {
    expect(claudePermissionMode([
      { type: 'sandbox/mode', data: { mode: sandboxMode } },
    ])).toBe(permissionMode)
  })

  it('uses the newest sandbox event and fails safe to plan for missing or invalid state', () => {
    expect(claudePermissionMode([])).toBe('plan')
    expect(claudePermissionMode([
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'invalid' } },
    ])).toBe('plan')
  })
})

describe('Claude supervisor', () => {
  it('passes Claude Code’s default alias explicitly when creating a Query', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const catalog = runtime.supportedCommands(owner.agent)
    await vi.waitFor(() => expect(transport.queries).toHaveLength(1))
    expect(transport.queries[0]?.options.model).toBe('default')
    transport.queries[0]!.push(init())
    await catalog
    await runtime.dispose()
  })

  it('starts the Query in the Claude mode mapped from DSH access', async () => {
    const transport = factory()
    const owner = fakeAgent()
    owner.events.push({
      type: 'sandbox/mode',
      data: { mode: 'workspace-write' },
      seq: owner.events.length,
      time: Date.now(),
    })
    const runtime = supervisor(transport.create)
    const catalog = runtime.supportedCommands(owner.agent)
    await vi.waitFor(() => expect(transport.queries).toHaveLength(1))
    expect(transport.queries[0]?.options.permissionMode).toBe('acceptEdits')
    expect(transport.queries[0]?.options.allowDangerouslySkipPermissions).toBe(true)
    transport.queries[0]!.push(init())
    await catalog
    await runtime.dispose()
  })

  it('syncs a changed native DSH access mode before the next Query operation', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const first = runtime.supportedCommands(owner.agent)
    await vi.waitFor(() => expect(transport.queries).toHaveLength(1))
    const query = transport.queries[0]!
    query.push(init())
    await first

    owner.events.push({
      type: 'sandbox/mode',
      data: { mode: 'danger-full-access' },
      seq: owner.events.length,
      time: Date.now(),
    })
    await runtime.contextUsage(owner.agent)
    expect(query.setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
    expect(query.setPermissionMode.mock.invocationCallOrder[0])
      .toBeLessThan(query.getContextUsage.mock.invocationCallOrder.at(-1)!)
    await runtime.dispose()
  })

  it('does not execute the next Query operation when permission-mode synchronization fails', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const first = runtime.supportedCommands(owner.agent)
    await vi.waitFor(() => expect(transport.queries).toHaveLength(1))
    const query = transport.queries[0]!
    query.push(init())
    await first

    owner.events.push({
      type: 'sandbox/mode',
      data: { mode: 'workspace-write' },
      seq: owner.events.length,
      time: Date.now(),
    })
    query.setPermissionMode.mockRejectedValueOnce(new Error('switch failed'))
    await expect(runtime.contextUsage(owner.agent)).rejects.toThrow('switch failed')
    expect(query.getContextUsage).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('reads the Claude command catalog without opening a DSH turn', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const catalog = runtime.supportedCommands(owner.agent)
    await vi.waitFor(() => expect(transport.queries).toHaveLength(1))
    transport.queries[0]!.push(init())
    await expect(catalog).resolves.toEqual([
      { name: 'review', description: 'Review changes', argumentHint: '<path>' },
    ])
    expect(transport.queries).toHaveLength(1)
    expect(owner.events.some(event => event.type === 'claude-code/activity')).toBe(false)
    await runtime.dispose()
  })

  it('reads authoritative context usage from the owned Query', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const usage = runtime.contextUsage(owner.agent)
    await vi.waitFor(() => expect(transport.queries).toHaveLength(1))
    transport.queries[0]!.push(init())
    await expect(usage).resolves.toMatchObject({
      totalTokens: 120,
      maxTokens: 200_000,
      model: 'claude-test',
    })
    expect(runtime.contextWindow('default')).toBe(200_000)
    expect(runtime.contextWindow('claude-test')).toBe(200_000)
    expect(transport.queries[0]?.getContextUsage).toHaveBeenCalledTimes(1)
    await runtime.dispose()
  })

  it('rejects metadata reads while the session has an active turn', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    await expect(runtime.contextUsage(owner.agent)).rejects.toBeInstanceOf(ClaudeTurnBusyError)
    transport.queries[0]!.push(init())
    transport.queries[0]!.push(result())
    await collect(output)
    await runtime.dispose()
  })

  it('forwards structured multimodal content without changing block order', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const content = [
      { type: 'text' as const, text: 'inspect this' },
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AQID' },
      },
    ]
    const output = await runtime.runTurn({ agent: owner.agent, prompt: content })
    const query = transport.queries[0]!
    const iterator = query.input[Symbol.asyncIterator]()
    const handshake = await iterator.next()
    const input = await iterator.next()
    expect(handshake.value?.message.content).toBe('/status')
    expect(input.value?.message).toEqual({ role: 'user', content })
    query.push(init())
    query.push(result())
    await collect(output)
    await runtime.dispose()
  })

  it('streams one complete turn and persists the Claude session binding', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    const query = transport.queries[0]!
    const iterator = query.input[Symbol.asyncIterator]()
    await iterator.next() // startup handshake
    const input = await iterator.next()
    expect(input.value?.message).toEqual({ role: 'user', content: 'hello' })
    query.push(init())
    query.push(delta('hel'))
    query.push(delta('lo'))
    query.push(result())
    await expect(collect(output)).resolves.toEqual([
      { type: 'text-delta', text: 'hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cumulativeCostUsd: 0.01 } },
      { type: 'complete', text: 'hello' },
    ])
    await expect(projection(runtime)).resolves.toMatchObject({
      binding: { claudeSessionId: 'claude-session-1' },
    })
    expect(runtime.snapshots()[0]).toMatchObject({ state: 'idle', claudeSessionId: 'claude-session-1' })
    await runtime.dispose()
  })

  it('tolerates a repeated system/init across turns', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    const query = transport.queries[0]!
    query.push(init())
    query.push(delta('hi'))
    query.push(init()) // re-emitted by 2.1.233 in long-lived mode
    query.push(result('hi'))
    await expect(collect(output)).resolves.toContainEqual({ type: 'complete', text: 'hi' })
    expect(runtime.snapshots()[0]).toMatchObject({ state: 'idle', claudeSessionId: 'claude-session-1' })
    await runtime.dispose()
  })

  it('surfaces the terminal reason for an is_error failure result', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    transport.queries[0]!.push(init())
    transport.queries[0]!.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      session_id: 'claude-session-1',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 0 },
    } as SDKMessage)
    await expect(collect(output)).rejects.toThrow(/api_error/)
    expect(runtime.snapshots()[0]).toMatchObject({ state: 'idle', claudeSessionId: 'claude-session-1' })
    await runtime.dispose()
  })

  it('tracks Claude tasks on the session board, including after the turn ends', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    const query = transport.queries[0]!
    query.push(init())
    query.push({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      description: 'Run deploy script',
      task_type: 'local_bash',
      session_id: 'claude-session-1',
    } as SDKMessage)
    query.push(result())
    await collect(output)
    await vi.waitFor(async () => {
      await expect(projection(runtime)).resolves.toMatchObject({
        tasks: { tasks: [{ taskId: 'task-1', description: 'Run deploy script', status: 'running', originTurn: 1, taskType: 'local_bash' }] },
      })
    })
    expect((await projection(runtime)).activities.some(activity => activity.taskId === 'task-1')).toBe(true)

    // The turn is over: background notifications must still reach the board.
    query.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      status: 'completed',
      summary: 'deploy finished',
      usage: { total_tokens: 120, tool_uses: 2, duration_ms: 3_000 },
      session_id: 'claude-session-1',
    } as SDKMessage)
    await vi.waitFor(async () => {
      await expect(projection(runtime)).resolves.toMatchObject({
        tasks: { tasks: [{
          taskId: 'task-1',
          status: 'completed',
          summary: 'deploy finished',
          usage: { totalTokens: 120, toolUses: 2, durationMs: 3_000 },
        }] },
      })
    })
    await runtime.dispose()
  })

  it('folds the background tasks level signal into the board', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    const query = transport.queries[0]!
    query.push(init())
    query.push({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1', task_type: 'local_bash', description: 'watch logs' }],
      session_id: 'claude-session-1',
    } as SDKMessage)
    await vi.waitFor(async () => {
      await expect(projection(runtime)).resolves.toMatchObject({
        tasks: { tasks: [{ taskId: 'bg-1', description: 'watch logs', status: 'running', originTurn: 1, backgrounded: true }] },
      })
    })
    query.push(result())
    await collect(output)

    // Membership leaving the level marks the task settled (REPLACE semantics).
    query.push({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
      session_id: 'claude-session-1',
    } as SDKMessage)
    await vi.waitFor(async () => {
      await expect(projection(runtime)).resolves.toMatchObject({
        tasks: { tasks: [{ taskId: 'bg-1', status: 'completed' }] },
      })
    })
    await runtime.dispose()
  })

  it('reports the latest cumulative cost without summing across turns', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const first = await runtime.runTurn({ agent: owner.agent, prompt: 'one' })
    const query = transport.queries[0]!
    query.push(init())
    query.push(result('one'))
    await collect(first)

    owner.events.push(
      { type: 'turn/start', data: { turn: 2 }, seq: owner.events.length, time: 3 },
      { type: 'step/start', data: { turn: 2, step: 1 }, seq: owner.events.length + 1, time: 4 },
    )
    const second = await runtime.runTurn({ agent: owner.agent, prompt: 'two' })
    query.push({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-session-1',
      result: 'two',
      total_cost_usd: 0.03,
      usage: { input_tokens: 6, output_tokens: 3 },
    } as SDKMessage)
    const secondEvents = await collect(second)
    // The SDK total_cost_usd is the running total; we must report 0.03, not 0.01 + 0.03.
    expect(secondEvents).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 6, outputTokens: 3, cumulativeCostUsd: 0.03 },
    })
    await runtime.dispose()
  })

  it('settles a completed turn even when durable activity append fails', async () => {
    const transport = factory()
    let failAfterStart = false
    const owner = fakeAgent()
    const root = join(tmpdir(), `dsh-claude-hook-${randomUUID()}`)
    sidecarRoots.push(root)
    const sidecar = new HookedSidecar(root, activity => {
      if (failAfterStart && activity.phase === 'completed') throw new Error('storage unavailable')
    })
    const runtime = supervisor(transport.create, 4, 60_000, sidecar)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    const query = transport.queries[0]!
    query.push(init())
    query.push(delta('hel'))
    failAfterStart = true
    query.push(result('hel'))
    await expect(collect(output)).resolves.toContainEqual({ type: 'complete', text: 'hel' })
    expect(runtime.snapshots()[0]).toMatchObject({ state: 'idle', claudeSessionId: 'claude-session-1' })
    await runtime.dispose()
  })

  it('passes the default alias explicitly when switching an existing Query back to Default', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const first = await runtime.runTurn({ agent: owner.agent, prompt: 'one', model: 'fable' })
    const query = transport.queries[0]!
    expect(query.options.model).toBe('fable')
    query.push(init())
    query.push(result('one'))
    await collect(first)

    owner.events.push(
      { type: 'turn/start', data: { turn: 2 }, seq: owner.events.length, time: 3 },
      { type: 'step/start', data: { turn: 2, step: 1 }, seq: owner.events.length + 1, time: 4 },
    )
    const second = await runtime.runTurn({ agent: owner.agent, prompt: 'two', model: 'default' })
    expect(query.setModel).toHaveBeenCalledWith('default')
    query.push(result('two'))
    await collect(second)
    await runtime.dispose()
  })

  it('reuses one streaming query for multiple turns', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const first = await runtime.runTurn({ agent: owner.agent, prompt: 'one' })
    const query = transport.queries[0]!
    query.push(init())
    query.push(result('one'))
    await collect(first)

    owner.events.push(
      { type: 'turn/start', data: { turn: 2 }, seq: owner.events.length, time: 3 },
      { type: 'step/start', data: { turn: 2, step: 1 }, seq: owner.events.length + 1, time: 4 },
    )
    const second = await runtime.runTurn({ agent: owner.agent, prompt: 'two' })
    query.push(result('two'))
    await expect(collect(second)).resolves.toContainEqual({ type: 'complete', text: 'two' })
    expect(transport.queries).toHaveLength(1)
    await runtime.dispose()
  })

  it('resumes the newest persisted Claude session binding', async () => {
    const transport = factory()
    const owner = fakeAgent()
    owner.events.push({
      type: 'claude-code/session-bound',
      data: { claudeSessionId: 'persisted-claude-session', sdkVersion: '0.3.233', cwd: '/workspace' },
      seq: owner.events.length,
      time: 5,
    })
    const runtime = supervisor(transport.create)
    await sidecars.get(runtime)!.importLegacy(owner.agent.id as string, owner.agent.session.events)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'continue' })
    expect(transport.queries[0]?.options.resume).toBe('persisted-claude-session')
    transport.queries[0]!.push(init('persisted-claude-session'))
    transport.queries[0]!.push(result('continued', 'persisted-claude-session'))
    await collect(output)
    await runtime.dispose()
  })

  it('creates only one query for concurrent first turns in one session', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const [firstPromise, secondPromise] = [
      runtime.runTurn({ agent: owner.agent, prompt: 'one' }),
      runtime.runTurn({ agent: owner.agent, prompt: 'two' }),
    ]
    const first = await firstPromise
    await expect(secondPromise).rejects.toBeInstanceOf(ClaudeTurnBusyError)
    expect(transport.queries).toHaveLength(1)
    transport.queries[0]!.push(init())
    transport.queries[0]!.push(result('one'))
    await collect(first)
    await runtime.dispose()
  })

  it('does not exceed the process cap for concurrent first turns across sessions', async () => {
    const transport = factory()
    const runtime = supervisor(transport.create, 1)
    const one = fakeAgent('one')
    const two = fakeAgent('two')
    const [firstPromise, secondPromise] = [
      runtime.runTurn({ agent: one.agent, prompt: 'one' }),
      runtime.runTurn({ agent: two.agent, prompt: 'two' }),
    ]
    const first = await firstPromise
    await expect(secondPromise).rejects.toBeInstanceOf(ClaudeProcessLimitError)
    expect(transport.queries).toHaveLength(1)
    transport.queries[0]!.push(init())
    transport.queries[0]!.push(result('one'))
    await collect(first)
    await runtime.dispose()
  })

  it('refuses concurrent top-level turns for one DSH session', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'one' })
    transport.queries[0]!.push(init())
    await expect(runtime.runTurn({ agent: owner.agent, prompt: 'two' })).rejects.toBeInstanceOf(ClaudeTurnBusyError)
    transport.queries[0]!.push(result('one'))
    await collect(output)
    await runtime.dispose()
  })

  it('classifies a disconnect before any Claude activity as retry-ineligible disconnect', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    transport.queries[0]!.fail(new Error('startup failed'))
    await expect(collect(output)).rejects.not.toBeInstanceOf(ClaudeOutcomeUnknownError)
    expect(runtime.snapshots()).toHaveLength(0)
    await runtime.dispose()
  })

  it('classifies a disconnect after visible activity as outcome unknown', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'edit something' })
    const query = transport.queries[0]!
    query.push(init())
    query.push(delta('working'))
    query.fail(new Error('process crashed'))
    await expect(collect(output)).rejects.toBeInstanceOf(ClaudeOutcomeUnknownError)
    expect(runtime.snapshots()).toHaveLength(0)
    await runtime.dispose()
  })

  it('never submits a prompt cancelled while recording the turn start', async () => {
    const transport = factory()
    const controller = new AbortController()
    const owner = fakeAgent()
    const root = join(tmpdir(), `dsh-claude-hook-${randomUUID()}`)
    sidecarRoots.push(root)
    const sidecar = new HookedSidecar(root, activity => {
      if (activity.phase === 'started') controller.abort()
    })
    const runtime = supervisor(transport.create, 4, 60_000, sidecar)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'must not run', signal: controller.signal })
    await expect(collect(output)).rejects.toMatchObject({ name: 'AbortError' })
    const query = transport.queries[0]!
    const iterator = query.input[Symbol.asyncIterator]()
    const handshake = await iterator.next()
    expect(handshake.value?.message.content).toBe('/status')
    let receivedPrompt = false
    void iterator.next().then(value => { receivedPrompt = !value.done })
    await Promise.resolve()
    expect(receivedPrompt).toBe(false)
    expect(query.interrupt).not.toHaveBeenCalled()
    expect(runtime.snapshots()[0]?.state).toBe('idle')
    await runtime.dispose()
  })

  it('ignores the handshake settlement even when it carries the handshake uuid', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    const query = transport.queries[0]!
    const handshake = await query.input[Symbol.asyncIterator]().next()
    query.push(init())
    query.push({ ...result('handshake output'), user_message_uuid: handshake.value?.uuid } as SDKMessage)
    query.push(result('real answer'))
    await expect(collect(output)).resolves.toContainEqual({ type: 'complete', text: 'real answer' })
    await runtime.dispose()
  })

  it('rejects an already-aborted request before allocating a query', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.runTurn({ agent: owner.agent, prompt: 'must not run', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.queries).toHaveLength(0)
    await runtime.dispose()
  })

  it('classifies a disconnect after a permission callback as outcome unknown', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'read a file' })
    const query = transport.queries[0]!
    await query.options.canUseTool?.('Read', { file_path: 'README.md' }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-1',
      requestId: 'request-1',
    })
    query.fail(new Error('process crashed after permission'))
    await expect(collect(output)).rejects.toBeInstanceOf(ClaudeOutcomeUnknownError)
    await runtime.dispose()
  })

  it('teardowns when the interrupt leaves the submitted prompt queued', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const controller = new AbortController()
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'long task', signal: controller.signal })
    const query = transport.queries[0]!
    const iterator = query.input[Symbol.asyncIterator]()
    await iterator.next() // startup handshake
    let promptUuid = ''
    void iterator.next().then(result => { promptUuid = result.value?.uuid ?? '' })
    await Promise.resolve()
    query.interrupt.mockResolvedValue({ still_queued: [promptUuid] })
    controller.abort()
    await expect(collect(output)).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(runtime.snapshots()).toHaveLength(0))
    await runtime.dispose()
  })

  it('tears down a hung interrupt after the bounded wait', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create, 4, 60_000)
    const controller = new AbortController()
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'long task', signal: controller.signal })
    const query = transport.queries[0]!
    query.interrupt.mockImplementation(() => new Promise(() => {}))
    controller.abort()
    await expect(collect(output)).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(runtime.snapshots()).toHaveLength(0), { timeout: 8_000, interval: 50 })
    await runtime.dispose()
  }, 10_000)

  it('rejects a result with the wrong user-message UUID', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    transport.queries[0]!.push(init())
    transport.queries[0]!.push({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-session-1',
      user_message_uuid: 'stale-user-message',
      result: 'wrong request',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as SDKMessage)
    await expect(collect(output)).rejects.toThrow(/user message stale-user-message/)
    expect(runtime.snapshots()).toHaveLength(0)
    await runtime.dispose()
  })

  it('tears down the submitted turn when DSH aborts', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const controller = new AbortController()
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'long task', signal: controller.signal })
    const query = transport.queries[0]!
    controller.abort()
    await expect(collect(output)).rejects.toMatchObject({ name: 'AbortError' })
    expect(query.interrupt).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(runtime.snapshots()).toHaveLength(0))
    await runtime.dispose()
  })

  it('evicts an idle query after the configured timeout', async () => {
    vi.useFakeTimers()
    try {
      const transport = factory()
      const owner = fakeAgent()
      const runtime = supervisor(transport.create, 4, 25)
      const output = await runtime.runTurn({ agent: owner.agent, prompt: 'one' })
      transport.queries[0]!.push(init())
      transport.queries[0]!.push(result('one'))
      await collect(output)
      expect(runtime.snapshots()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(25)
      expect(runtime.snapshots()).toHaveLength(0)
      await runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('mirrors root Claude tool calls into the native tool channel', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'look around' })
    const query = transport.queries[0]!
    query.push(init())
    query.push(toolCallMessage)
    query.push(toolResultMessage)
    query.push(result('done'))
    await collect(output)
    const call = owner.events.find(event => event.type === 'tool/call')
    expect(call?.data).toMatchObject({ turn: 1, step: 1, callId: 'tool-1', name: 'Bash' })
    expect((call?.data as { arguments: string }).arguments).toContain('ls -la')
    const settled = owner.events.find(event => event.type === 'tool/result')
    const block = (settled?.data as { message: { content: Array<{ toolCallId: string; isError: boolean; content: Array<{ text: string }> }> } }).message.content[0]
    expect(block?.toolCallId).toBe('tool-1')
    expect(block?.isError).toBe(false)
    expect(block?.content[0]?.text).toContain('listed')
    await runtime.dispose()
  })

  it('settles a native tool card when Claude reports permission denied', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'pull latest' })
    const query = transport.queries[0]!
    query.push(init())
    query.push(toolCallMessage)
    query.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
      message: 'The user rejected this action in DeepSeek Harness.',
    } as SDKMessage)
    query.push(result('not pulled'))
    await collect(output)

    const settled = owner.events.find(event => event.type === 'tool/result')
    const block = (settled?.data as { message: { content: Array<{ toolCallId: string; isError: boolean; content: Array<{ text: string }> }> } }).message.content[0]
    expect(block?.toolCallId).toBe('tool-1')
    expect(block?.isError).toBe(true)
    expect(block?.content[0]?.text).toContain('rejected')
    await runtime.dispose()
  })

  it('does not mirror subagent-nested tool calls into the native tool channel', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'delegate' })
    const query = transport.queries[0]!
    query.push(init())
    query.push({
      type: 'assistant',
      parent_tool_use_id: 'parent-call',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'nested-1', name: 'Read', input: { file_path: 'README.md' } }],
      },
    } as SDKMessage)
    query.push(result('done'))
    await collect(output)
    expect(owner.events.some(event => event.type === 'tool/call')).toBe(false)
    expect(owner.registeredTools).toEqual([])
    await runtime.dispose()
  })

  it('registers a dynamic presenter for unknown tool names exactly once', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'search the vault' })
    const query = transport.queries[0]!
    query.push(init())
    query.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'mcp-1', name: 'mcp__obsidian__search_simple', input: { query: 'Navi' } },
          { type: 'tool_use', id: 'mcp-2', name: 'mcp__obsidian__search_simple', input: { query: 'Slack' } },
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    } as SDKMessage)
    query.push(result('done'))
    await collect(output)
    // The MCP tool gets one agent-scoped mirror; the statically covered Bash gets none.
    expect(owner.registeredTools).toEqual(['mcp__obsidian__search_simple'])
    await runtime.dispose()
  })

  it('keeps Task dispatches out of the native channel and summarizes them by description', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'explore' })
    const query = transport.queries[0]!
    query.push(init())
    query.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Explore Navi module', prompt: 'survey' } }],
      },
    } as SDKMessage)
    query.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'task-1', content: 'report' }],
      },
      tool_use_result: 'report',
    } as SDKMessage)
    query.push(result('done'))
    await collect(output)
    expect(owner.events.some(event => event.type === 'tool/call')).toBe(false)
    expect(owner.events.some(event => event.type === 'tool/result')).toBe(false)
    const activities = (await projection(runtime)).activities
    expect(activities.some(event => event.summary === 'Explore Navi module')).toBe(true)
    expect(activities.some(event => event.kind === 'tool-result')).toBe(true)
    await runtime.dispose()
  })

  it('evicts the least-recently-idle entry to respect the process cap', async () => {
    const transport = factory()
    const runtime = supervisor(transport.create, 1)
    const firstOwner = fakeAgent('one')
    const first = await runtime.runTurn({ agent: firstOwner.agent, prompt: 'one' })
    transport.queries[0]!.push(init('one-claude-session'))
    transport.queries[0]!.push(result('one', 'one-claude-session'))
    await collect(first)

    const secondOwner = fakeAgent('two')
    const second = await runtime.runTurn({ agent: secondOwner.agent, prompt: 'two' })
    expect(transport.queries).toHaveLength(2)
    transport.queries[1]!.push(init('two-claude-session'))
    transport.queries[1]!.push(result('two', 'two-claude-session'))
    await collect(second)
    await runtime.dispose()
  })

  it('passes the selected thinking mode into the Claude options', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello', thinkingMode: 'max' })
    expect(transport.queries[0]?.options.effort).toBe('max')
    expect(transport.queries[0]?.options.thinking).toBeUndefined()
    expect(transport.queries[0]?.options.settings).toBeUndefined()
    transport.queries[0]!.push(init())
    transport.queries[0]!.push(result())
    await collect(output)
    expect(runtime.snapshots()[0]).toMatchObject({ thinkingMode: 'max' })
    await runtime.dispose()
  })

  it('disables extended thinking for the off mode', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello', thinkingMode: 'off' })
    expect(transport.queries[0]?.options.thinking).toEqual({ type: 'disabled' })
    expect(transport.queries[0]?.options.effort).toBeUndefined()
    transport.queries[0]!.push(init())
    transport.queries[0]!.push(result())
    await collect(output)
    await runtime.dispose()
  })

  it('enables ultracode through the flag settings layer', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello', thinkingMode: 'ultracode' })
    expect(transport.queries[0]?.options.settings).toEqual({ ultracode: true })
    expect(transport.queries[0]?.options.effort).toBeUndefined()
    transport.queries[0]!.push(init())
    transport.queries[0]!.push(result())
    await collect(output)
    await runtime.dispose()
  })

  it('rebuilds the query when the thinking mode changes and resumes the bound session', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const first = await runtime.runTurn({ agent: owner.agent, prompt: 'one' })
    expect(transport.queries[0]?.options.effort).toBeUndefined()
    transport.queries[0]!.push(init())
    transport.queries[0]!.push(result('one'))
    await collect(first)

    owner.events.push(
      { type: 'turn/start', data: { turn: 2 }, seq: owner.events.length, time: 3 },
      { type: 'step/start', data: { turn: 2, step: 1 }, seq: owner.events.length + 1, time: 4 },
    )
    const second = await runtime.runTurn({ agent: owner.agent, prompt: 'two', thinkingMode: 'xhigh' })
    expect(transport.queries).toHaveLength(2)
    expect(transport.queries[1]?.options.effort).toBe('xhigh')
    expect(transport.queries[1]?.options.resume).toBe('claude-session-1')
    transport.queries[1]!.push(init())
    transport.queries[1]!.push(result('two'))
    await collect(second)

    owner.events.push(
      { type: 'turn/start', data: { turn: 3 }, seq: owner.events.length, time: 5 },
      { type: 'step/start', data: { turn: 3, step: 1 }, seq: owner.events.length + 1, time: 6 },
    )
    const third = await runtime.runTurn({ agent: owner.agent, prompt: 'three', thinkingMode: 'xhigh' })
    expect(transport.queries).toHaveLength(2)
    transport.queries[1]!.push(result('three'))
    await expect(collect(third)).resolves.toContainEqual({ type: 'complete', text: 'three' })
    await runtime.dispose()
  })
})
