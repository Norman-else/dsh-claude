import { describe, expect, it } from 'vitest'

import { HOST_CHROME_CSS } from '../src/client/host-chrome.ts'
import { CLAUDE_SEAT_ATTRIBUTE } from '../src/client/preset-seat-mark.ts'

describe('host chrome suppression', () => {
  it('hides the Host Session log capsule by its CSS Module local name', () => {
    // The emitted class carries a build hash; matching the local name is what
    // survives a Host rebuild.
    expect(HOST_CHROME_CSS).toContain('button[class*="sessionLogButton"]')
  })

  it('hides the more-actions menu the export moved into on Host 0.1.5', () => {
    // Host 0.1.5 replaced the capsule with an ellipsis button whose only menu
    // item is the download; the local name is unique to that package.
    expect(HOST_CHROME_CSS).toContain('button[class*="moreButton"][aria-haspopup="menu"]')
    expect(HOST_CHROME_CSS).toMatch(/button\[class\*="sessionLogButton"\],button\[class\*="moreButton"\]\[aria-haspopup="menu"\]\{display:none\}/)
  })

  it('hides the header tab strip only in headers this plugin acts on', () => {
    // Without the :has() scope this would strip the view tabs from every
    // Session in the App, including ones driven by other agent presets.
    // Host 0.1.7 nests the strip inside the header's Slot outlet, so the match
    // is a descendant one; a direct-child match silently missed it.
    expect(HOST_CHROME_CSS).toContain('header:has(.dsh-claude-header-diff) [role="tablist"]{display:none}')
    // Every tablist selector must sit behind the :has() scope, so none of them
    // may start a rule (rules start at the CSS head or right after a `}`).
    for (const rule of HOST_CHROME_CSS.split('}').map(part => part.trim()).filter(Boolean)) {
      if (rule.includes('[role="tablist"]')) expect(rule.startsWith('header:has(.dsh-claude-header-diff)')).toBe(true)
    }
  })

  it('hides the Host access selector only in a tool row holding this plugin\'s own', () => {
    // The Host element is found by the PermissionSelect module's own local
    // name, and only inside a row where the plugin's selector has mounted:
    // that selector mounts for Claude sessions alone, so other presets keep
    // the Host's three-mode control.
    // Host 0.1.7 renders it through a Slot outlet whose inline
    // `display:contents` beats any rule without `!important`.
    expect(HOST_CHROME_CSS).toContain('[class*="_tools"]:has(.dshClaudePermissionSelect) [data-slot="conversation.input.permission"]{display:none!important}')
    expect(HOST_CHROME_CSS).toContain('[class*="_tools"]:has(.dshClaudePermissionSelect) [class*="_modes"]>*:has(span[class*="_triggerLabel"]){display:none!important}')
    for (const rule of HOST_CHROME_CSS.split('}').map(part => part.trim()).filter(Boolean)) {
      if (rule.includes('_triggerLabel') || rule.includes('conversation.input.permission')) {
        expect(rule.startsWith('[class*="_tools"]:has(.dshClaudePermissionSelect)')).toBe(true)
      }
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
