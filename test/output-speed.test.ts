import { describe, expect, it } from 'vitest'
import { OutputSpeedMeter, tokensPerSecond } from '../src/output-speed.ts'
import { sessionTokensPerSecond, usageTokensPerSecond } from '../src/client/conversation-sidecar.ts'
import type { ClaudeActivityEvent } from '../src/events.ts'

const event = (type: string, extra: Record<string, unknown> = {}, parent?: string) => ({
  type: 'stream_event',
  event: { type, ...extra },
  ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
})
const delta = (parent?: string) => event('content_block_delta', { delta: { type: 'text_delta', text: 'x' } }, parent)
const end = (tokens: number, parent?: string) => event('message_delta', { usage: { output_tokens: tokens } }, parent)

describe('OutputSpeedMeter', () => {
  it('times a request from its first delta to its message_delta, not from message_start', () => {
    const meter = new OutputSpeedMeter()
    meter.observe(event('message_start'), 0)
    meter.observe(delta(), 1_000) // time to first token is not decode time
    meter.observe(event('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{' } }), 1_500)
    meter.observe(end(100), 3_000)
    expect(meter.sample()).toEqual({ outputTokens: 100, decodeMs: 2_000 })
  })

  it('drops bursts: too few tokens, or a request delivered in one chunk', () => {
    const meter = new OutputSpeedMeter()
    meter.observe(delta(), 0)
    meter.observe(end(1), 500)
    meter.observe(event('message_start'), 600)
    meter.observe(delta(), 1_000)
    meter.observe(end(688), 1_001)
    meter.observe(end(50), 2_000) // no delta opened this one
    expect(meter.sample()).toBeUndefined()
  })

  it('keeps a separate clock per subagent so parallel requests do not overlap', () => {
    const meter = new OutputSpeedMeter()
    meter.observe(delta(), 0)
    meter.observe(delta('task-1'), 500)
    meter.observe(end(30, 'task-1'), 1_500)
    meter.observe(end(60), 2_000)
    expect(meter.sample()).toEqual({ outputTokens: 90, decodeMs: 3_000 })
  })

  it('ignores non-stream messages', () => {
    const meter = new OutputSpeedMeter()
    meter.observe({ type: 'assistant' }, 0)
    meter.observe(null, 0)
    expect(meter.sample()).toBeUndefined()
  })
})

describe('tokensPerSecond', () => {
  it('weights by decode time instead of averaging rates', () => {
    // 100 tok/s over 1 s and 10 tok/s over 9 s: 190 tok in 10 s, not 55.
    expect(tokensPerSecond([{ outputTokens: 100, decodeMs: 1_000 }, { outputTokens: 90, decodeMs: 9_000 }, undefined])).toBe(19)
    expect(tokensPerSecond([])).toBeUndefined()
  })
})

describe('session reading', () => {
  it('sums each turn once, using its newest report', () => {
    const usage = (turn: number, decodeOutputTokens: number, decodeMs: number): ClaudeActivityEvent => ({
      turn, step: 1, ordinal: 0, kind: 'usage', phase: 'completed', usage: { decodeOutputTokens, decodeMs },
    })
    const activities = [usage(1, 10, 1_000), usage(1, 100, 2_000), usage(2, 200, 2_000), { ...usage(3, 9_999, 1), renderer: 'native' as const }]
    expect(sessionTokensPerSecond(activities)).toBe(75)
    expect(usageTokensPerSecond([{ outputTokens: 5 }])).toBeUndefined()
  })
})
