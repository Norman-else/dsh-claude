import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseAskEvent } from '../src/client/ask-api.ts'
import { ClaudeSelectionAsk, popupPosition, toolbarPosition } from '../src/client/ClaudeSelectionAsk.tsx'

describe('selection ask client', () => {
  it('parses answer stream events', () => {
    expect(parseAskEvent('{"type":"delta","text":"Hi"}')).toEqual({ type: 'delta', text: 'Hi' })
    expect(parseAskEvent('{"type":"thinking","text":"hmm"}')).toEqual({ type: 'thinking', text: 'hmm' })
    expect(parseAskEvent('{"type":"done"}')).toEqual({ type: 'done' })
    expect(parseAskEvent('{"type":"error","message":"nope"}')).toEqual({ type: 'error', message: 'nope' })
    expect(() => parseAskEvent('{"type":"mystery"}')).toThrow('Invalid ask stream event')
  })

  it('keeps the toolbar and popup inside the viewport', () => {
    expect(toolbarPosition({ top: 12, left: 5, width: 40, bottom: 30 }, 1_000)).toEqual({ top: 8, left: 8 })
    expect(toolbarPosition({ top: 300, left: 900, width: 200, bottom: 320 }, 1_000)).toEqual({ top: 260, left: 928 })
    expect(popupPosition({ top: 100, left: 20, width: 300, bottom: 120 }, 1_000, 800)).toEqual({ top: 128, left: 20, width: 560 })
    // No room below: sit above the selection instead of covering it.
    expect(popupPosition({ top: 700, left: 600, width: 300, bottom: 720 }, 1_000, 800)).toEqual({ top: 372, left: 432, width: 560 })
    expect(popupPosition({ top: 700, left: 600, width: 300, bottom: 720 }, 1_000, 800, 200)).toEqual({ top: 492, left: 432, width: 560 })
    // Room on neither side: clamp inside the viewport.
    expect(popupPosition({ top: 300, left: 0, width: 300, bottom: 320 }, 1_000, 600, 500)).toEqual({ top: 92, left: 8, width: 560 })
  })

  it('renders nothing until a selection inside an assistant reply exists', () => {
    const markup = renderToStaticMarkup(<ClaudeSelectionAsk t={((key: string) => key) as never} currentSessionId={() => 'session'} ownsSession={() => true} />)
    expect(markup).toBe('<span data-dsh-claude-selection-ask="armed" hidden=""></span>')
  })
})
