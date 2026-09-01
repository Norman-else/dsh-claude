// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { locateClaudePresetSeat, showsOtherPresetSeat } from '../src/client/hero-dom-bridge.ts'

/** The hero row as the Host builds it: a labelled workspace picker beside the
 *  unlabelled preset seat. */
function mountHero(presetName: string): void {
  document.body.innerHTML = `
    <div data-phase="hero">
      <div>
        <span><button aria-haspopup="menu" aria-label="workspace">premier-store-os</button></span>
        <span><button aria-haspopup="menu">${presetName}</button></span>
      </div>
    </div>`
}

afterEach(() => { document.body.innerHTML = '' })

describe('hero preset seat', () => {
  it('reads the seat while it names Claude and reports a switch away from it', () => {
    mountHero('Claude')
    expect(locateClaudePresetSeat()).not.toBeUndefined()
    expect(showsOtherPresetSeat()).toBe(false)

    // Switching presets only rewrites the label, so the miss below is the sole
    // signal that the controls must come down rather than wait out a re-render.
    mountHero('Cordis')
    expect(locateClaudePresetSeat()).toBeUndefined()
    expect(showsOtherPresetSeat()).toBe(true)
  })

  it('stays quiet while no hero is settled, so a re-render keeps its portal', () => {
    document.body.innerHTML = ''
    expect(showsOtherPresetSeat()).toBe(false)
    document.body.innerHTML = '<div data-phase="hero"></div>'
    expect(showsOtherPresetSeat()).toBe(false)
  })
})
