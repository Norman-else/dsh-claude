import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClaudeTurnUsage, cacheHitRate, formatTurnDuration, turnUsageParts } from '../src/client/ClaudeActivityNode.tsx'
import { transcriptItemsForStep } from '../src/client/conversation-sidecar.ts'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { en } from '../src/client/locales.ts'

const t = ((key: keyof typeof en, params?: Record<string, unknown>) => {
  const copy = en[key]
  return params === undefined ? copy : copy.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name]))
}) as never

const USAGE = {
  inputTokens: 4,
  outputTokens: 902,
  cacheReadTokens: 78_000,
  cacheCreationTokens: 1_610,
  cumulativeCostUsd: 5.938_694_5,
  durationMs: 128_000,
  ttftMs: 1_240,
}

describe('formatTurnDuration', () => {
  it('spends precision only where it means something', () => {
    expect(formatTurnDuration(420)).toBe('420ms')
    expect(formatTurnDuration(1_240)).toBe('1.2s')
    expect(formatTurnDuration(42_400)).toBe('42s')
    expect(formatTurnDuration(128_000)).toBe('2m 08s')
  })
})

describe('cacheHitRate', () => {
  it('counts reads against everything assembling the prompt cost', () => {
    expect(cacheHitRate({ cacheReadTokens: 90, cacheCreationTokens: 5, inputTokens: 5 })).toBeCloseTo(0.9)
    // A turn that read nothing scores zero rather than dividing by nothing.
    expect(cacheHitRate({ inputTokens: 10 })).toBe(0)
    expect(cacheHitRate({ outputTokens: 10 })).toBeUndefined()
  })
})

describe('turnUsageParts', () => {
  it('reads size, then cache, then time, then money', () => {
    expect(turnUsageParts(USAGE, t)).toEqual(['80.5K tok', 'Cache hit 98.0%', '2m 08s', 'TTFT 1.2s', '$5.94 total'])
  })

  it('leaves out what the turn never reported', () => {
    expect(turnUsageParts({ outputTokens: 12 }, t)).toEqual(['12 tok'])
  })
})

describe('ClaudeTurnUsage', () => {
  it('draws the footer the Host only gives its own messages', () => {
    const markup = renderToStaticMarkup(<ClaudeTurnUsage usage={USAGE} t={t} />)
    expect(markup).toContain(en.turnUsage)
    expect(markup).toContain('Cache hit 98.0%')
  })

  it('renders nothing rather than an empty label', () => {
    expect(renderToStaticMarkup(<ClaudeTurnUsage usage={{}} t={t} />)).toBe('')
  })
})

describe('transcriptItemsForStep', () => {
  it('closes the step with the turn accounting', () => {
    const activities: ClaudeActivityEvent[] = [
      { turn: 1, step: 1, ordinal: 0, kind: 'text', text: 'done' },
      { turn: 1, step: 1, ordinal: 1, kind: 'usage', phase: 'completed', title: 'Claude usage', usage: USAGE },
    ]

    expect(transcriptItemsForStep(activities, 1, 1)).toEqual([
      { kind: 'text', ordinal: 0, text: 'done' },
      { kind: 'usage', ordinal: 1, usage: USAGE },
    ])
  })

  it('keeps a usage record with nothing in it out of the transcript', () => {
    const activities: ClaudeActivityEvent[] = [
      { turn: 1, step: 1, ordinal: 0, kind: 'usage', phase: 'completed', title: 'Claude usage' },
    ]

    expect(transcriptItemsForStep(activities, 1, 1)).toEqual([])
  })
})
