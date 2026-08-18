import { describe, expect, it, vi } from 'vitest'
import type {
  Options as ClaudeOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AsyncQueue } from '../src/async-queue.ts'
import {
  ClaudeOutcomeUnknownError,
  ClaudeProcessLimitError,
  ClaudeSupervisor,
  ClaudeTurnBusyError,
  type ClaudeQueryFactory,
  type ClaudeTurnStreamEvent,
} from '../src/supervisor.ts'

class FakeQuery extends AsyncQueue<SDKMessage> {
  readonly interrupt = vi.fn(async () => undefined)
  readonly setModel = vi.fn(async () => undefined)
  readonly options: ClaudeOptions
  readonly input: AsyncIterable<SDKUserMessage>

  constructor(input: AsyncIterable<SDKUserMessage>, options: ClaudeOptions) {
    super()
    this.input = input
    this.options = options
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
  const session = {
    header: { cwd },
    get events() { return events },
    append: async (type: string, data: unknown) => {
      onAppend?.(type, data)
      const event = { type, data, seq: events.length, time: Date.now() }
      events.push(event)
      return event
    },
  }
  const agent = { id, session } as unknown as Agent
  return { agent, events }
}

function supervisor(create: ClaudeQueryFactory, maxProcesses = 4, idleTimeoutMs = 60_000) {
  return new ClaudeSupervisor({
    runtime: { spawn: () => { throw new Error('fake query must not spawn') } },
    approval: { request: async () => 'rejected' },
    config: {
      executablePath: '/local/claude',
      idleTimeoutMs,
      maxProcesses,
      defaultModel: 'default',
    },
    queryFactory: create,
  })
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

async function collect(stream: AsyncIterable<ClaudeTurnStreamEvent>): Promise<ClaudeTurnStreamEvent[]> {
  const events: ClaudeTurnStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('Claude supervisor', () => {
  it('streams one complete turn and persists the Claude session binding', async () => {
    const transport = factory()
    const owner = fakeAgent()
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'hello' })
    const query = transport.queries[0]!
    const input = await query.input[Symbol.asyncIterator]().next()
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
    expect(owner.events.some(event => event.type === 'claude-code/session-bound')).toBe(true)
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
    query.push(delta('working'))
    query.fail(new Error('process crashed'))
    await expect(collect(output)).rejects.toBeInstanceOf(ClaudeOutcomeUnknownError)
    expect(runtime.snapshots()).toHaveLength(0)
    await runtime.dispose()
  })

  it('never submits a prompt cancelled while recording the turn start', async () => {
    const transport = factory()
    const controller = new AbortController()
    const owner = fakeAgent('dsh-session-1', '/workspace', (type, data) => {
      if (type === 'claude-code/activity' && (data as { phase?: string }).phase === 'started') controller.abort()
    })
    const runtime = supervisor(transport.create)
    const output = await runtime.runTurn({ agent: owner.agent, prompt: 'must not run', signal: controller.signal })
    await expect(collect(output)).rejects.toMatchObject({ name: 'AbortError' })
    const query = transport.queries[0]!
    let receivedPrompt = false
    void query.input[Symbol.asyncIterator]().next().then(value => { receivedPrompt = !value.done })
    await Promise.resolve()
    expect(receivedPrompt).toBe(false)
    expect(query.interrupt).not.toHaveBeenCalled()
    expect(runtime.snapshots()[0]?.state).toBe('idle')
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
    let promptUuid = ''
    void query.input[Symbol.asyncIterator]().next().then(result => { promptUuid = result.value?.uuid ?? '' })
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
})
