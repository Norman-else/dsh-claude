import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ClaudeSessionMenu, ClaudeSessionMenuCard } from '../src/client/ClaudeSessionMenu.tsx'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

const t = (key: ClaudeCodeSettingsKey): string => en[key]

function render(owned: boolean) {
  const snapshot: ClaudeClientProjection = { ...EMPTY_CLAUDE_PROJECTION, owned }
  return renderToStaticMarkup(<ClaudeSessionMenu
    t={t}
    sessionId="session-1"
    useClaudeProjection={<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)}
    openInEditor={async () => {}}
  />)
}

function card(submenuOpen: boolean, failure?: string) {
  return renderToStaticMarkup(<ClaudeSessionMenuCard
    openIn="Open in"
    submenuOpen={submenuOpen}
    failure={failure}
    onSubmenuOpen={vi.fn()}
    onSelect={vi.fn()}
  />)
}

describe('Claude session header menu', () => {
  it('renders a collapsed kebab trigger carrying the menu label', () => {
    const markup = render(true)

    expect(markup).toContain('aria-label="Session menu"')
    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('aria-expanded="false"')
    // The DSH tooltip bubble carries the hint; the native popup must not fire too.
    expect(markup).not.toContain('title=')
    // Collapsed: the menu card only exists once the trigger is pressed.
    expect(markup).not.toContain('dsh-claude-header-menu-card')
  })

  it('renders nothing in sessions this plugin does not own', () => {
    expect(render(false)).toBe('')
  })
})

describe('Claude session menu card', () => {
  it('offers a collapsed "Open in" row that advertises a nested menu', () => {
    const markup = card(false)

    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('aria-expanded="false"')
    // The chevron tells the row it opens a second card rather than acting.
    expect(markup).toContain('<span>Open in</span><svg')
    expect(markup).not.toContain('IntelliJ IDEA')
  })

  it('opens a side card headed by the parent row and listing both editors', () => {
    const markup = card(true)

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('<div class="dsh-claude-header-menu-sub" role="menu">')
    // The side card repeats the row's own label as its grey heading.
    expect(markup).toContain('<div class="dsh-claude-header-menu-heading">Open in</div>')
    expect(markup).toContain('<span>Cursor</span>')
    expect(markup).toContain('<span>IntelliJ IDEA</span>')
  })

  it('keeps a failed launch visible on the only surface still on screen', () => {
    expect(card(false, 'Could not open: nope')).toContain('Could not open: nope')
  })
})
