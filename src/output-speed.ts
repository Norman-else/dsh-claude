/** Real model output speed, measured off the SDK's partial-message stream.
 *
 *  DSH's own tok/s divides a step's output by the time between the first and
 *  last chunk it received. This plugin hands DSH the turn's prose in one piece
 *  at the end, and one DSH step is a whole Claude Code turn (many API calls
 *  and tool runs), so that number is either missing or absurd. The honest
 *  clock is per API request: from its first content delta (text, thinking or
 *  tool input) to its `message_delta`, which carries that request's
 *  `output_tokens`.
 *
 *  Subagent requests count too: they are the same model decoding, and each
 *  `parent_tool_use_id` gets its own clock, so parallel subagents never share
 *  one request's span. Totals are time-weighted (sum of tokens over sum of
 *  decode time), never an average of per-request rates. */

/** Below this a request is a burst, not a measurement. */
export const MIN_REQUEST_OUTPUT_TOKENS = 2
/** A request that "decoded" faster than this arrived in one chunk. */
export const MIN_REQUEST_DECODE_MS = 100

export interface OutputSpeedSample {
  outputTokens: number
  decodeMs: number
}

interface StreamEnvelope {
  type?: unknown
  parent_tool_use_id?: unknown
  event?: { type?: unknown; usage?: { output_tokens?: unknown } }
}

export class OutputSpeedMeter {
  /** When each open request (keyed by its parent tool call, '' at the root) put its first delta on the wire. */
  readonly #firstDeltaAt = new Map<string, number>()
  outputTokens = 0
  decodeMs = 0

  observe(message: unknown, now: number): void {
    const value = message as StreamEnvelope | null
    if (value?.type !== 'stream_event') return
    const key = typeof value.parent_tool_use_id === 'string' ? value.parent_tool_use_id : ''
    const type = value.event?.type
    if (type === 'message_start') {
      this.#firstDeltaAt.delete(key)
    } else if (type === 'content_block_delta') {
      if (!this.#firstDeltaAt.has(key)) this.#firstDeltaAt.set(key, now)
    } else if (type === 'message_delta') {
      const startedAt = this.#firstDeltaAt.get(key)
      this.#firstDeltaAt.delete(key)
      const tokens = value.event?.usage?.output_tokens
      if (startedAt === undefined || typeof tokens !== 'number') return
      const elapsed = now - startedAt
      if (tokens < MIN_REQUEST_OUTPUT_TOKENS || elapsed < MIN_REQUEST_DECODE_MS) return
      this.outputTokens += tokens
      this.decodeMs += elapsed
    }
  }

  sample(): OutputSpeedSample | undefined {
    return this.decodeMs > 0 ? { outputTokens: this.outputTokens, decodeMs: this.decodeMs } : undefined
  }
}

/** Time-weighted rate over any number of samples. */
export function tokensPerSecond(samples: readonly (OutputSpeedSample | undefined)[]): number | undefined {
  let tokens = 0
  let ms = 0
  for (const sample of samples) {
    if (sample === undefined) continue
    tokens += sample.outputTokens
    ms += sample.decodeMs
  }
  return ms > 0 ? tokens / (ms / 1000) : undefined
}
