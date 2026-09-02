import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ClaudeDiffHeaderAction } from '../src/client/ClaudeDiffHeaderAction.tsx'
import { PanelOpenStore } from '../src/client/panel-open-store.ts'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

const t = (key: ClaudeCodeSettingsKey): string => en[key]

function projectionHook(owned: boolean, diff?: { additions: number; deletions: number }) {
  const snapshot: ClaudeClientProjection = {
    ...EMPTY_CLAUDE_PROJECTION,
    owned,
    ...(diff === undefined ? {} : {
      repository: { status: 'ready' as const, cwd: '/repo', root: '/repo', diff: { ...diff, files: 4, truncated: false } },
    }),
  }
  return <S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)
}

function render(owned: boolean, openFor?: string, diff?: { additions: number; deletions: number }) {
  const store = new PanelOpenStore()
  if (openFor !== undefined) store.open(openFor)
  return renderToStaticMarkup(<ClaudeDiffHeaderAction
    t={t}
    sessionId="session-1"
    toggleDiff={vi.fn()}
    diffOpen={store.sourceFor('session-1')}
    useClaudeProjection={projectionHook(owned, diff)}
  />)
}

describe('Claude diff header action', () => {
  it('renders an unpressed icon-only button carrying the diff label', () => {
    const markup = render(true)

    expect(markup).toContain('aria-label="View branch changes"')
    expect(markup).toContain('aria-pressed="false"')
    // The DSH tooltip bubble carries the hint; the native `title` popup must
    // not also fire, or both render on hover.
    expect(markup).not.toContain('title=')
    // The plus-over-minus glyph, drawn inline: primitives ship no diff icon.
    // The class matters — the glyph's size and stroke are pinned from CSS,
    // because presentation attributes lose to any ancestor rule.
    expect(markup).toContain('<svg class="dsh-claude-header-diff-glyph"')
    expect(markup).toContain('aria-hidden="true"')
    // Icon-only: no text label leaks into the header action row.
    expect(markup).not.toContain('View branch changes<')
  })

  it('marks itself pressed and offers to close while this session owns the open diff panel', () => {
    const markup = render(true, 'session-1')

    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('aria-label="Close diff panel"')
  })

  it('stays unpressed while another session owns the open diff panel', () => {
    expect(render(true, 'session-2')).toContain('aria-pressed="false"')
  })

  it('renders nothing in sessions this plugin does not own', () => {
    expect(render(false)).toBe('')
  })

  it('carries the live diff counts beside the glyph', () => {
    const markup = render(true, undefined, { additions: 262, deletions: 0 })

    expect(markup).toContain('<span class="dsh-claude-header-diff-add">+262</span>')
    expect(markup).toContain('<span class="dsh-claude-header-diff-del">−0</span>')
    expect(markup).toContain('data-counts="true"')
  })

  it('stays a bare glyph while the branch carries no changes', () => {
    const markup = render(true, undefined, { additions: 0, deletions: 0 })

    expect(markup).not.toContain('data-counts')
    expect(markup).not.toContain('dsh-claude-header-diff-add')
  })
})

describe('diff open store', () => {
  it('answers isOpen per session', () => {
    const store = new PanelOpenStore()

    expect(store.isOpen('session-1')).toBe(false)
    store.open('session-1')
    expect(store.isOpen('session-1')).toBe(true)
    expect(store.isOpen('session-2')).toBe(false)
    store.close()
    expect(store.isOpen('session-1')).toBe(false)
  })

  it('notifies subscribers and reports per-session open state', () => {
    const store = new PanelOpenStore()
    const source = store.sourceFor('session-1')
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)

    expect(source.getSnapshot()).toBe(false)
    store.open('session-1')
    expect(source.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    store.close()
    expect(source.getSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.open('session-1')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not notify when the open session is unchanged', () => {
    const store = new PanelOpenStore()
    const listener = vi.fn()
    store.sourceFor('session-1').subscribe(listener)

    store.open('session-1')
    store.open('session-1')

    expect(listener).toHaveBeenCalledTimes(1)
  })
})
