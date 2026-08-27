import { describe, expect, it } from 'vitest'

import { HOST_CHROME_CSS } from '../src/client/host-chrome.ts'
import { CLAUDE_SEAT_ATTRIBUTE } from '../src/client/preset-seat-mark.ts'

describe('host chrome suppression', () => {
  it('hides the Host Session log capsule by its CSS Module local name', () => {
    // The emitted class carries a build hash; matching the local name is what
    // survives a Host rebuild.
    expect(HOST_CHROME_CSS).toContain('button[class*="sessionLogButton"]{display:none}')
  })

  it('hides the header tab strip only in headers this plugin acts on', () => {
    // Without the :has() scope this would strip the view tabs from every
    // Session in the App, including ones driven by other agent presets.
    expect(HOST_CHROME_CSS).toContain('header:has(.dsh-claude-header-diff)>[role="tablist"]{display:none}')
    // Every tablist selector must sit behind the :has() scope, so none of them
    // may start a rule (rules start at the CSS head or right after a `}`).
    for (const rule of HOST_CHROME_CSS.split('}').map(part => part.trim()).filter(Boolean)) {
      if (rule.includes('[role="tablist"]')) expect(rule.startsWith('header:has(.dsh-claude-header-diff)')).toBe(true)
    }
  })

  it('restores the slack the tab row used to give the divider', () => {
    expect(HOST_CHROME_CSS).toContain('header:has(.dsh-claude-header-diff){padding-bottom:10px}')
  })

  it('swaps the preset seat glyph only behind the flag that says it names Claude', () => {
    expect(HOST_CHROME_CSS).toContain(`button[${CLAUDE_SEAT_ATTRIBUTE}]>[class*="seatIcon"]{display:none}`)
    // An unflagged seat must keep the Host glyph: the seat names whichever
    // preset is staged, so an unconditional rule would brand `standard` too.
    for (const rule of HOST_CHROME_CSS.split('}').map(part => part.trim()).filter(Boolean)) {
      if (rule.includes('seatIcon')) expect(rule.startsWith(`button[${CLAUDE_SEAT_ATTRIBUTE}]`)).toBe(true)
    }
  })
})
