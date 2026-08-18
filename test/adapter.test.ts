import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeAdapter, extractDirectUserText } from '../src/adapter.ts'
import type { ClaudeSupervisor, ClaudeTurnStreamEvent } from '../src/supervisor.ts'

const user = (text: string, kind: 'user' | 'plugin' = 'user') => ({
  id: crypto.randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'test' },
}) as unknown as Message

const agent = { id: 'session-1' } as unknown as Agent
const claudePreset = () => 'claude-code-cli'

function options(messages: Message[] = [user('hello')]): GenerateOptions {
  return {
    provider: 'claude-code-cli',
    model: 'default',
    messages,
    sessionId: 'session-1' as never,
  }
}

function supervisorEvents(events: ClaudeTurnStreamEvent[], error?: unknown) {
  return {
    runTurn: async function* () {
      for (const event of events) yield event
      if (error !== undefined) throw error
    },
  } as unknown as ClaudeSupervisor
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
  it('emits one valid text block, usage, then terminal finish', async () => {
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
      { type: 'text-delta', index: 0, text: 'hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
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
    }).rejects.toThrow(/available only to the claude-code-cli preset/)
  })

  it('disables outer DSH retries', () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, claudePreset)
    expect(adapter.providerRetryPolicy('claude-code-cli')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })
})
