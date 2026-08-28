import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClaudeRewind, rewindMessageText } from '../src/client/ClaudeRewind.tsx'
import { rewindHiddenCss, sameClaudeRewindSeats } from '../src/client/rewind-dom.ts'
import { EMPTY_CLAUDE_PROJECTION } from '../src/client/projection.ts'
import { PLUGIN_READ_TIMEOUT_MS, pluginRequestSignal } from '../src/client/plugin-request.ts'

describe('rewind client', () => {
  it('reads the plain text of a user message the way the copy action does', () => {
    expect(rewindMessageText({ content: [{ type: 'text', text: 'fix ' }, { type: 'image' }, { type: 'text', text: 'the bug' }] })).toBe('fix the bug')
    expect(rewindMessageText({ content: 'plain' })).toBe('plain')
    expect(rewindMessageText(undefined)).toBe('')
  })

  it('hides exactly the rewound rows and refuses unquotable keys', () => {
    expect(rewindHiddenCss([])).toBe('')
    expect(rewindHiddenCss(['input-message:a', 'claude-activity-step:b']))
      .toBe('[data-chat-flow-key="input-message:a"],[data-chat-flow-key="claude-activity-step:b"]{display:none}')
    expect(rewindHiddenCss(['bad"key'])).toBe('')
  })

  it('compares seats by key and host identity', () => {
    const host = { nodeName: 'SPAN' } as unknown as HTMLElement
    const other = { nodeName: 'SPAN' } as unknown as HTMLElement
    expect(sameClaudeRewindSeats([{ key: 'a', host }], [{ key: 'a', host }])).toBe(true)
    expect(sameClaudeRewindSeats([{ key: 'a', host }], [{ key: 'a', host: other }])).toBe(false)
    expect(sameClaudeRewindSeats([{ key: 'a', host }], [])).toBe(false)
  })

  it('bounds a plugin request and still honours the caller cancellation', () => {
    const caller = new AbortController()
    const signal = pluginRequestSignal(PLUGIN_READ_TIMEOUT_MS, caller.signal)
    expect(signal.aborted).toBe(false)
    caller.abort()
    expect(signal.aborted).toBe(true)
    expect(pluginRequestSignal(PLUGIN_READ_TIMEOUT_MS).aborted).toBe(false)
  })

  it('stays inert in a session this plugin does not own', () => {
    const markup = renderToStaticMarkup(<ClaudeRewind
      t={((key: string) => key) as never}
      currentSessionId={() => 'session'}
      subscribeSessions={() => () => {}}
      chatOf={() => undefined}
      projectionOf={() => ({ subscribe: () => () => {}, getSnapshot: () => EMPTY_CLAUDE_PROJECTION })}
    />)
    expect(markup).toBe('<span data-dsh-claude-rewind-armed="armed" hidden=""></span>')
  })
})
