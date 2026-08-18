import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { normalizeSdkMessage } from '../src/sdk-messages.ts'

const sdk = (value: unknown) => value as SDKMessage

describe('Claude SDK message normalization', () => {
  it('normalizes initialization without authentication material', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      claude_code_version: '2.1.233',
      cwd: '/workspace',
      apiKeySource: 'user',
    }))).toEqual([{ kind: 'init', sessionId: 'session-1', cliVersion: '2.1.233', cwd: '/workspace' }])
  })

  it('normalizes partial visible text', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    }))).toEqual([{ kind: 'text-delta', text: 'hello' }])
  })

  it('normalizes assistant tool use and completed thinking', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [
        { type: 'thinking', thinking: 'considering' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.txt' } },
      ] },
    }))).toEqual([
      { kind: 'thinking', text: 'considering', phase: 'completed' },
      { kind: 'tool-call', toolUseId: 'tool-1', toolName: 'Read', input: { file_path: 'a.txt' } },
    ])
  })

  it('normalizes structured tool results', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'user',
      parent_tool_use_id: null,
      tool_use_result: { content: 'file contents' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }] },
    }))).toEqual([{ kind: 'tool-result', toolUseId: 'tool-1', output: { content: 'file contents' }, isError: false }])
  })

  it('normalizes successful result usage', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      result: 'done',
      total_cost_usd: 0.012,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    }))).toEqual([{
      kind: 'result',
      success: true,
      text: 'done',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1, cumulativeCostUsd: 0.012 },
      sessionId: 'session-1',
    }])
  })

  it('classifies an is_error success-subtype result as failure', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      session_id: 'session-1',
      result: 'ignored',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    }))).toEqual([{
      kind: 'result',
      success: false,
      terminalReason: 'api_error',
      usage: { inputTokens: 1, outputTokens: 1, cumulativeCostUsd: 0 },
      sessionId: 'session-1',
    }])
  })

  it('treats aborted_streaming terminal reasons as non-error', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'aborted_streaming',
      session_id: 'session-1',
      result: 'partial',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    }))).toMatchObject([{ kind: 'result', success: true, terminalReason: 'aborted_streaming' }])
  })

  it('preserves unknown message types as bounded-normalization inputs', () => {
    expect(normalizeSdkMessage(sdk({ type: 'future_message', value: 1 }))).toEqual([{
      kind: 'unknown',
      title: 'Unknown Claude SDK message: future_message',
      detail: { type: 'future_message', value: 1 },
    }])
  })
})
