import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseAskEvent } from '../src/client/ask-api.ts'
import { ClaudeSelectionAsk, answerText, appendAnswerBlock, popupPlacement, popupSide, toolbarPosition } from '../src/client/ClaudeSelectionAsk.tsx'

describe('selection ask client', () => {
  it('parses answer stream events', () => {
    expect(parseAskEvent('{"type":"delta","text":"Hi"}')).toEqual({ type: 'delta', text: 'Hi' })
    expect(parseAskEvent('{"type":"thinking","text":"hmm"}')).toEqual({ type: 'thinking', text: 'hmm' })
    expect(parseAskEvent('{"type":"tool","id":"t1","phase":"input","name":"Read","summary":"a.ts"}')).toEqual({ type: 'tool', id: 't1', phase: 'input', name: 'Read', summary: 'a.ts' })
    expect(parseAskEvent('{"type":"done"}')).toEqual({ type: 'done' })
    expect(parseAskEvent('{"type":"error","message":"nope"}')).toEqual({ type: 'error', message: 'nope' })
    expect(() => parseAskEvent('{"type":"mystery"}')).toThrow('Invalid ask stream event')
  })

  it('interleaves tool steps and text like the main window', () => {
    let blocks = appendAnswerBlock([], { type: 'text', text: 'Let me check. ' })
    blocks = appendAnswerBlock(blocks, { type: 'tool', id: 't1', phase: 'start', name: 'Grep' })
    blocks = appendAnswerBlock(blocks, { type: 'tool', id: 't1', phase: 'input', summary: 'loadURL' })
    blocks = appendAnswerBlock(blocks, { type: 'tool', id: 't1', phase: 'done' })
    blocks = appendAnswerBlock(blocks, { type: 'text', text: 'Because ' })
    blocks = appendAnswerBlock(blocks, { type: 'text', text: 'of X.' })
    blocks = appendAnswerBlock(blocks, { type: 'tool', id: 'ghost', phase: 'done' })
    expect(blocks).toEqual([
      { kind: 'text', text: 'Let me check. ' },
      { kind: 'tool', id: 't1', name: 'Grep', summary: 'loadURL', state: 'done' },
      { kind: 'text', text: 'Because of X.' },
    ])
    expect(answerText(blocks)).toBe('Let me check.\n\nBecause of X.')
  })

  it('keeps the toolbar and popup inside the viewport', () => {
    expect(toolbarPosition({ top: 12, left: 5, width: 40, bottom: 30 }, 1_000)).toEqual({ top: 8, left: 8 })
    expect(toolbarPosition({ top: 300, left: 900, width: 200, bottom: 320 }, 1_000)).toEqual({ top: 260, left: 928 })
    expect(popupSide({ top: 100, left: 20, width: 300, bottom: 120 }, 800)).toBe('below')
    expect(popupSide({ top: 700, left: 600, width: 300, bottom: 720 }, 800)).toBe('above')
    // Below: anchored by top, capped to the room underneath so growth scrolls.
    expect(popupPlacement({ top: 100, left: 20, width: 300, bottom: 120 }, 'below', 1_000, 800)).toEqual({ top: 128, left: 20, width: 560, maxHeight: 560 })
    // Above: anchored by bottom so streamed content grows upward, capped to the room above.
    expect(popupPlacement({ top: 700, left: 600, width: 300, bottom: 720 }, 'above', 1_000, 800)).toEqual({ bottom: 108, left: 432, width: 560, maxHeight: 560 })
    expect(popupPlacement({ top: 150, left: 0, width: 300, bottom: 170 }, 'above', 1_000, 800)).toEqual({ bottom: 658, left: 8, width: 560, maxHeight: 134 })
  })

  it('renders nothing until a selection inside an assistant reply exists', () => {
    const markup = renderToStaticMarkup(<ClaudeSelectionAsk t={((key: string) => key) as never} currentSessionId={() => 'session'} ownsSession={() => true} />)
    expect(markup).toBe('<span data-dsh-claude-selection-ask="armed" hidden=""></span>')
  })
})
