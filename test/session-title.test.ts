import { describe, expect, it } from 'vitest'
import type { Options as ClaudeOptions, Query } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { ClaudeCodeAdapter } from '../src/adapter.ts'
import { sessionTitleLine, summarizeSessionTitle, type SessionTitleRequest } from '../src/session-title.ts'
import type { ClaudeSupervisor } from '../src/supervisor.ts'

type QueryParams = { prompt: string; options: ClaudeOptions }

function fakeQuery(...results: unknown[]): Query {
  return {
    async *[Symbol.asyncIterator]() { for (const item of results) yield item },
  } as unknown as Query
}

const success = (result: string) => ({ type: 'result', subtype: 'success', result })

const SYSTEM = 'Create a concise title for an AI coding-assistant session.\nUse the language of the messages.'
const INPUT = 'Generate the session title from this JSON array of human messages:\n[{"seq":1,"text":"帮我拆分 PSOS-5714"}]'

describe('sessionTitleLine', () => {
  it('keeps the first non-empty line and leaves normalization to DSH', () => {
    expect(sessionTitleLine('  拆分 PSOS-5714 前后端工单 \n')).toBe('拆分 PSOS-5714 前后端工单')
    expect(sessionTitleLine('\n\nSplit the receivable ticket\nHope that helps!')).toBe('Split the receivable ticket')
    expect(sessionTitleLine('   \n  ')).toBe('')
  })
})

describe('summarizeSessionTitle', () => {
  it("carries DSH's instruction into an isolated single-turn Haiku query", async () => {
    let params: QueryParams | undefined
    const factory = (value: QueryParams): Query => {
      params = value
      return fakeQuery(success('拆分 PSOS-5714 前后端工单'))
    }
    await expect(summarizeSessionTitle('/opt/claude', { system: SYSTEM, input: INPUT }, factory))
      .resolves.toBe('拆分 PSOS-5714 前后端工单')
    expect(params?.prompt).toBe(`${SYSTEM}\n\n${INPUT}`)
    // A project CLAUDE.md aimed at the coding session would answer the wrong
    // question, and the title turn must not touch tools or the transcript.
    expect(params?.options).toMatchObject({
      model: 'haiku',
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      pathToClaudeCodeExecutable: '/opt/claude',
    })
  })

  it('rejects an empty or unsuccessful turn so DSH keeps its fallback title', async () => {
    await expect(summarizeSessionTitle('', { input: INPUT }, () => fakeQuery(success('  \n '))))
      .rejects.toThrow(/produced no title/)
    await expect(summarizeSessionTitle('', { input: INPUT }, () => fakeQuery({ type: 'result', subtype: 'error_during_execution' })))
      .rejects.toThrow(/produced no title/)
    await expect(summarizeSessionTitle('', { input: '   ' }, () => fakeQuery(success('unused'))))
      .rejects.toThrow(/carried no text/)
  })

  it('aborts the throwaway turn when the title service supersedes it', async () => {
    const controller = new AbortController()
    let options: ClaudeOptions | undefined
    const factory = (value: QueryParams): Query => {
      options = value.options
      controller.abort()
      return fakeQuery(success('too late'))
    }
    await summarizeSessionTitle('', { input: INPUT, signal: controller.signal }, factory)
      .catch(() => undefined)
    expect(options?.abortController?.signal.aborted).toBe(true)
  })
})

describe('Claude Code adapter session titles', () => {
  const agent = { id: 'session-1' } as unknown as Agent
  const supervisor = {} as unknown as ClaudeSupervisor
  const attachments = { imageLimits: {}, readImage: async () => { throw new Error('unused') } } as unknown as Pick<AttachmentStore, 'imageLimits' | 'readImage'>
  const message = (text: string) => ({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  }) as unknown as Message

  const adapter = (summarize: (request: SessionTitleRequest) => Promise<string>) => new ClaudeCodeAdapter(
    supervisor,
    { currentInitiator: () => agent, get: () => agent },
    attachments,
    () => 'claude',
    () => [],
    () => 'plugin',
    summarize,
  )

  it('answers the title request as one text block without opening a turn', async () => {
    let request: SessionTitleRequest | undefined
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter(async value => {
      request = value
      return '拆分 PSOS-5714 前后端工单'
    }).stream({
      provider: 'claude',
      model: 'claude-opus-5',
      system: SYSTEM,
      messages: [message(INPUT)],
      purpose: 'session-title',
    })) chunks.push(chunk)
    expect(request).toEqual({ system: SYSTEM, input: INPUT })
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '拆分 PSOS-5714 前后端工单' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '拆分 PSOS-5714 前后端工单' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('still refuses compaction, which Claude Code owns', async () => {
    await expect(async () => {
      for await (const _chunk of adapter(async () => 'unused').stream({
        provider: 'claude',
        model: 'claude-opus-5',
        messages: [message('summarize this')],
        purpose: 'compaction',
      })) { /* no chunks expected */ }
    }).rejects.toThrow(/auxiliary compaction calls are not routed/)
  })
})
