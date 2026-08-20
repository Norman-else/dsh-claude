import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeAdapter, extractDirectUserText } from '../src/adapter.ts'
import { CLAUDE_CODE_PROVIDER_IDS } from '../src/constants.ts'
import type { ClaudeSupervisor, ClaudeTurnStreamEvent } from '../src/supervisor.ts'

const user = (text: string, kind: 'user' | 'plugin' = 'user') => ({
  id: crypto.randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'test' },
}) as unknown as Message

const agent = { id: 'session-1' } as unknown as Agent
const claudePreset = () => 'claude'

function options(messages: Message[] = [user('hello')]): GenerateOptions {
  return {
    provider: 'claude',
    model: 'default',
    messages,
    sessionId: 'session-1' as never,
  }
}

function supervisorEvents(events: ClaudeTurnStreamEvent[], error?: unknown, contextWindow?: number) {
  return {
    contextWindow: () => contextWindow,
    runTurn: async function* () {
      for (const event of events) yield event
      if (error !== undefined) throw error
    },
  } as unknown as ClaudeSupervisor
}

function capturingSupervisor(events: ClaudeTurnStreamEvent[] = [{ type: 'complete', text: 'ok' }]) {
  const calls: Array<{ prompt: string; model?: string; thinkingMode?: string }> = []
  const supervisor = {
    contextWindow: () => undefined,
    runTurn: (request: { prompt: string; model?: string; thinkingMode?: string }) => {
      calls.push(request)
      return (async function* () {
        for (const event of events) yield event
      })()
    },
  } as unknown as ClaudeSupervisor
  return { supervisor, calls }
}

describe('direct prompt extraction', () => {
  it('uses the newest direct human text and ignores injected plugin context', () => {
    expect(extractDirectUserText([
      user('human prompt'),
      user('injected notice', 'plugin'),
    ])).toBe('human prompt')
  })

  it('rejects an image-only prompt', () => {
    const message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'image', attachment: {} }],
      source: { kind: 'user' },
    } as unknown as Message
    expect(() => extractDirectUserText([message])).toThrow(/image-only/)
  })
})

describe('DSH stream mapping', () => {
  it('settles the accumulated text as one block at turn completion', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([
      { type: 'text-delta', text: 'hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 } },
      { type: 'complete', text: 'hello' },
    ]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('emits no text block for a turn without visible text', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
      { type: 'complete', text: '' },
    ]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks.some(chunk => chunk.type === 'block-start')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('emits no Claude tool calls into the DSH stream', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([
      { type: 'text-delta', text: 'done' },
      { type: 'complete', text: 'done' },
    ]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
  })

  it('emits an aborted finish instead of throwing an AbortError', async () => {
    const abort = new Error('Claude Code turn aborted')
    abort.name = 'AbortError'
    const adapter = new ClaudeCodeAdapter(supervisorEvents([{ type: 'text-delta', text: 'partial' }], abort), {
      currentInitiator: () => agent,
      get: () => agent,
    }, claudePreset)
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'aborted', message: 'Claude Code turn aborted' } } },
    ])
  })

  it('rejects a native or recomposed session even if the global provider is selected', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, () => 'standard')
    await expect(async () => {
      for await (const _chunk of adapter.stream(options())) { /* no chunks expected */ }
    }).rejects.toThrow(/available only to the claude preset/)
  })

  it('disables outer DSH retries', () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    expect(adapter.providerRetryPolicy('claude')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })
})

describe('Claude Code model catalog', () => {
  it('registers only the current Claude provider in the model selector', () => {
    expect(CLAUDE_CODE_PROVIDER_IDS).toEqual(['claude'])
  })

  it('advertises the five native Claude Code choices and aliases in CLI order', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    const models = await adapter.listModels('claude')
    expect(models.map(model => ({ id: model.id, name: model.name }))).toEqual([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'opus[1m]', name: 'Opus (1M context)' },
      { id: 'fable', name: 'Fable' },
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'haiku', name: 'Haiku' },
    ])
  })

  it('publishes the explicit 1M alias capacity through the native DSH model contract', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    await expect(adapter.resolveModel('claude', 'opus[1m]')).resolves.toMatchObject({
      context: { contextWindow: 1_000_000 },
    })
  })

  it('publishes an SDK-observed capacity for dynamic Claude aliases', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([], undefined, 272_000), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    await expect(adapter.resolveModel('claude', 'default')).resolves.toMatchObject({
      context: { contextWindow: 272_000 },
    })
  })

  it('omits unverified capacity until Claude reports it', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    const model = await adapter.resolveModel('claude', 'sonnet')
    expect(model.context).toBeUndefined()
  })

  it('forwards the selected native alias unchanged to the supervisor', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, claudePreset)
    for await (const _chunk of adapter.stream({ ...options(), model: 'opus[1m]' })) { /* drain */ }
    expect(calls[0]).toMatchObject({ model: 'opus[1m]' })
  })
})

describe('reasoning effort', () => {
  it('advertises the seven Claude thinking modes for selector surfaces', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    const info = await adapter.resolveModel('claude', 'sonnet')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(info.reasoning?.defaultEffort).toBeUndefined()
  })

  it('forwards the selected thinking mode to the supervisor', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, claudePreset)
    for await (const _chunk of adapter.stream({ ...options(), reasoningEffort: ReasoningEffortId('max') })) { /* drain */ }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ prompt: 'hello', thinkingMode: 'max' })
  })

  it('omits the thinking mode when no effort is selected', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, claudePreset)
    for await (const _chunk of adapter.stream(options())) { /* drain */ }
    expect(calls[0]).not.toHaveProperty('thinkingMode')
  })

  it('rejects an unknown reasoning effort before touching the Claude session', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, claudePreset)
    await expect(async () => {
      for await (const _chunk of adapter.stream({ ...options(), reasoningEffort: ReasoningEffortId('turbo') })) { /* no chunks expected */ }
    }).rejects.toThrow(/unsupported reasoning effort/)
    expect(calls).toHaveLength(0)
  })
})
