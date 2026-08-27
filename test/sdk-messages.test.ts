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

  it('ignores replayed and string-content user messages instead of failing the protocol', () => {
    // CLI ≥ 2.1.238 replays prior user messages on resume, including
    // local-command output echoes whose content is a plain string.
    expect(normalizeSdkMessage(sdk({
      type: 'user',
      isReplay: true,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'old' }] },
    }))).toEqual([])
    expect(normalizeSdkMessage(sdk({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: '<local-command-stdout>Set model to fable</local-command-stdout>' },
    }))).toEqual([])
    expect(normalizeSdkMessage(sdk({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user' },
    }))).toEqual([{ kind: 'protocol-error', title: 'Malformed Claude user message', detail: expect.anything() }])
  })

  it('normalizes the per-call prompt accounting an assistant message carries', () => {
    // This is the sample DSH's context meter divides by the context window.
    // The result message's usage sums every call the turn made and must never
    // stand in for it.
    expect(normalizeSdkMessage(sdk({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 12, output_tokens: 30, cache_read_input_tokens: 155_000, cache_creation_input_tokens: 400 },
      },
    }))).toEqual([
      { kind: 'assistant-text', text: 'hi' },
      {
        kind: 'request-usage',
        usage: { inputTokens: 12, outputTokens: 30, cacheReadTokens: 155_000, cacheCreationTokens: 400 },
      },
    ])
  })

  it('keeps a subagent call out of the main conversation prompt sample', () => {
    // A subagent bills against its own context; adopting its prompt size would
    // make the meter read whichever subagent happened to answer last.
    expect(normalizeSdkMessage(sdk({
      type: 'assistant',
      parent_tool_use_id: 'task-1',
      message: { content: [], usage: { input_tokens: 3, output_tokens: 1 } },
    }))).toEqual([{
      kind: 'request-usage',
      usage: { inputTokens: 3, outputTokens: 1 },
      parentToolUseId: 'task-1',
    }])
  })

  it('reports no prompt sample when an assistant message carries no usage', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'hi' }] },
    }))).toEqual([{ kind: 'assistant-text', text: 'hi' }])
  })

  it('normalizes the compaction boundary that /compact leaves behind', () => {
    // `/compact` runs no model turn and its `Compacted` echo is a block-less
    // user message, so this boundary is the only trace the conversation was
    // rewritten. Falling through to the generic 'status' fallback would make a
    // compacted conversation render nothing at all.
    expect(normalizeSdkMessage(sdk({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'session-1',
      compact_metadata: { trigger: 'manual', pre_tokens: 128_000, post_tokens: 32_000, duration_ms: 4_200 },
    }))).toEqual([{ kind: 'compaction', trigger: 'manual', preTokens: 128_000, postTokens: 32_000, durationMs: 4_200 }])
  })

  it('keeps the compaction boundary usable when the CLI reports no metadata', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'session-1',
    }))).toEqual([{ kind: 'compaction' }])
    // An unrecognized trigger is dropped rather than guessed: the divider says
    // a compaction happened without claiming who asked for it.
    expect(normalizeSdkMessage(sdk({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'session-1',
      compact_metadata: { trigger: 'scheduled', pre_tokens: 'lots' },
    }))).toEqual([{ kind: 'compaction' }])
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

  it('normalizes result permission denials for dedup', () => {
    expect(normalizeSdkMessage(sdk({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      result: 'done',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'x' } },
        { tool_name: 'Edit', tool_use_id: 'tool-2', tool_input: {} },
      ],
    }))).toMatchObject([{
      kind: 'result',
      permissionDenials: [
        { toolName: 'Bash', toolUseId: 'tool-1' },
        { toolName: 'Edit', toolUseId: 'tool-2' },
      ],
    }])
  })

  it('preserves unknown message types as bounded-normalization inputs', () => {
    expect(normalizeSdkMessage(sdk({ type: 'future_message', value: 1 }))).toEqual([{
      kind: 'unknown',
      title: 'Unknown Claude SDK message: future_message',
      detail: { type: 'future_message', value: 1 },
    }])
  })

  it('keeps every rate limit update audit-only while titling blocking states distinctly', () => {
    const healthy = normalizeSdkMessage(sdk({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: 1787042400, rateLimitType: 'five_hour', isUsingOverage: false },
    }))
    expect(healthy).toMatchObject([{ kind: 'status', title: 'Claude rate limit status changed' }])
    const blocked = normalizeSdkMessage(sdk({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'blocked', rateLimitType: 'five_hour' },
    }))
    expect(blocked).toMatchObject([{ kind: 'status', title: 'Claude rate limit is blocking requests' }])
  })
})
