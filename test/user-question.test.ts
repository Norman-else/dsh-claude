import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ClaudeActivityInput } from '../src/events.ts'
import { createUserQuestionBridge } from '../src/user-question.ts'

const agent = { id: 'agent-1' } as Agent

function context(appendActivity = vi.fn(async (_activity: ClaudeActivityInput) => undefined)) {
  return {
    agent,
    cursor: { turn: 2, step: 3, nextOrdinal: 1 },
    markActivity: vi.fn(),
    appendActivity,
  }
}

describe('Claude AskUserQuestion bridge', () => {
  it('maps single-select, multi-select, and custom answers into Claude updatedInput', async () => {
    const ask = vi.fn(async () => ({
      answers: [
        { id: 'tool-1:0', selected: ['PostgreSQL'] },
        { id: 'tool-1:1', selected: ['Tests', 'Docs'], custom: 'Benchmarks' },
        { id: 'tool-1:2', selected: [], custom: 'Use Beijing time' },
      ],
    }))
    const active = context()
    const bridge = createUserQuestionBridge({ ask }, () => active)
    const input = {
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          options: [{ label: 'PostgreSQL', description: 'Relational' }],
          multiSelect: false,
        },
        {
          question: 'Which deliverables?',
          header: 'Scope',
          options: [{ label: 'Tests' }, { label: 'Docs' }],
          multiSelect: true,
        },
        {
          question: 'Any constraints?',
          header: 'Details',
          options: [],
          multiSelect: false,
        },
      ],
    }

    await expect(bridge(input, {
      signal: new AbortController().signal,
      toolUseID: 'tool-1',
      requestId: 'request-1',
    })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: {
          'Which database?': 'PostgreSQL',
          'Which deliverables?': 'Tests, Docs, Benchmarks',
          'Any constraints?': 'Use Beijing time',
        },
      },
      toolUseID: 'tool-1',
      decisionClassification: 'user_temporary',
    })
    expect(ask).toHaveBeenCalledWith({
      agent,
      signal: expect.any(AbortSignal),
      questions: [
        {
          id: 'tool-1:0',
          question: 'Which database?',
          header: 'Database',
          options: [{ label: 'PostgreSQL', description: 'Relational' }],
          multiSelect: false,
        },
        {
          id: 'tool-1:1',
          question: 'Which deliverables?',
          header: 'Scope',
          options: [{ label: 'Tests' }, { label: 'Docs' }],
          multiSelect: true,
        },
        {
          id: 'tool-1:2',
          question: 'Any constraints?',
          header: 'Details',
          options: [],
          multiSelect: false,
        },
      ],
    })
    expect(active.markActivity).toHaveBeenCalledOnce()
    expect(active.appendActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'question',
      phase: 'completed',
      toolUseId: 'tool-1',
    }))
    expect(active.appendActivity.mock.calls.at(-1)?.[0]).not.toHaveProperty('detail')
  })

  it('fails closed and exposes only a stable native error code', async () => {
    const nativeError = Object.assign(new Error('sensitive provider detail'), { code: 'CALLER_NOT_LIVE' })
    const ask = vi.fn(async () => { throw nativeError })
    const active = context()
    const bridge = createUserQuestionBridge({ ask }, () => active)

    await expect(bridge({ questions: [{ question: 'Continue?', options: [] }] }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-2',
      requestId: 'request-2',
    })).resolves.toEqual({
      behavior: 'deny',
      message: 'DeepSeek Harness could not collect an answer; the question was cancelled. (CALLER_NOT_LIVE)',
      toolUseID: 'tool-2',
      decisionClassification: 'user_reject',
    })
    expect(active.appendActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'question',
      phase: 'failed',
      summary: 'DeepSeek Harness could not collect an answer; the question was cancelled. (CALLER_NOT_LIVE)',
      isError: true,
    }))
    expect(JSON.stringify(active.appendActivity.mock.calls)).not.toContain('sensitive provider detail')
  })

  it('rejects malformed input without opening the native question surface', async () => {
    const ask = vi.fn()
    const bridge = createUserQuestionBridge({ ask }, () => context())

    const result = await bridge({ questions: [{ question: '', options: [] }] }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-3',
      requestId: 'request-3',
    })
    expect(result).toMatchObject({ behavior: 'deny', toolUseID: 'tool-3' })
    expect(ask).not.toHaveBeenCalled()
  })
})
