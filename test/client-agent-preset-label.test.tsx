import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ClaudeAgentPresetLabel } from '../src/client/ClaudeAgentPresetLabel.tsx'
import { AgentPresetRoster, presetDisplayText, type AgentPresetRow } from '../src/client/agent-preset-roster.ts'
import { claudeMarkUrl } from '../src/client/claude-mark.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

const t = (key: ClaudeCodeSettingsKey): string => en[key]
/** Stands in for the Host namespace: known keys translate, others echo back. */
const hostT = (key: string): string => ({
  presetCordisName: 'Cordis',
  presetCordisDescription: 'Compose a session from Cordis plugins.',
}[key] ?? key)

function render(preset: string | undefined, rows: readonly AgentPresetRow[] = []) {
  const sessions = { byId: { 'session-1': preset === undefined ? {} : { agentPreset: preset } } }
  return renderToStaticMarkup(<ClaudeAgentPresetLabel
    t={t}
    hostT={hostT}
    roster={{ subscribe: () => () => {}, getSnapshot: () => rows, load: vi.fn() }}
    sessionId="session-1"
    useSessions={<S,>(selector: (value: typeof sessions) => S): S => selector(sessions)}
  />)
}

describe('Claude mark', () => {
  it('percent-encodes the data URI so the brand colour cannot end the url() token', () => {
    const url = claudeMarkUrl()

    expect(url.startsWith('url("data:image/svg+xml;utf8,%3Csvg')).toBe(true)
    expect(url).toContain('%23d97757')
    expect(url).not.toContain('#d97757')
  })
})

describe('preset display text', () => {
  it('translates presets the Host ships', () => {
    const row: AgentPresetRow = { id: 'cordis', trust: 'system', name: 'cordis-from-file' }

    expect(presetDisplayText(row, 'cordis', hostT)).toEqual({
      name: 'Cordis',
      description: 'Compose a session from Cordis plugins.',
    })
  })

  it('falls back to file metadata for presets the Host does not ship copy for', () => {
    const row: AgentPresetRow = { id: 'claude', trust: 'system', name: 'Claude', description: 'Use the local Claude Code.' }

    expect(presetDisplayText(row, 'claude', hostT)).toEqual({ name: 'Claude', description: 'Use the local Claude Code.' })
  })

  it('never renders a locale key when the Host dictionary misses', () => {
    // `standard` is in the built-in map but this hostT has no copy for it, so
    // echoing the key back must not reach the header.
    const row: AgentPresetRow = { id: 'standard', trust: 'system', name: 'Standard' }

    expect(presetDisplayText(row, 'standard', hostT)).toEqual({ name: 'Standard' })
  })

  it('falls back to the session\'s preset id before the roster arrives', () => {
    expect(presetDisplayText(undefined, 'claude', hostT)).toEqual({ name: 'claude' })
  })

  it('ignores built-in copy for a locally authored preset that squats a shipped id', () => {
    const row: AgentPresetRow = { id: 'cordis', trust: 'user', name: 'My Cordis' }

    expect(presetDisplayText(row, 'cordis', hostT)).toEqual({ name: 'My Cordis' })
  })
})

describe('Claude agent preset label', () => {
  it('brands the Claude preset and drops the native title popup', () => {
    const markup = render('claude', [{ id: 'claude', trust: 'system', name: 'Claude', description: 'Use the local Claude Code.' }])

    expect(markup).toContain('dsh-claude-preset-mark')
    expect(markup).toContain('>Claude</span>')
    // The description rides the DSH tooltip bubble now, not `title`.
    expect(markup).not.toContain('title=')
    expect(markup).not.toContain('dsh-claude-preset-icon')
  })

  it('keeps the stock glyph and name for every other preset', () => {
    const markup = render('cordis', [{ id: 'cordis', trust: 'system' }])

    expect(markup).toContain('dsh-claude-preset-icon')
    expect(markup).toContain('>Cordis</span>')
    expect(markup).not.toContain('dsh-claude-preset-mark')
  })

  it('renders nothing until the session records a preset', () => {
    expect(render(undefined)).toBe('')
  })
})

describe('agent preset roster', () => {
  it('publishes the rows a successful read returned', async () => {
    const list = vi.fn().mockResolvedValue({ result: { ok: true, value: { presets: [{ id: 'claude', trust: 'system' }] } } })
    const roster = new AgentPresetRoster({ list })
    const listener = vi.fn()
    roster.subscribe(listener)

    roster.load()
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())

    expect(roster.getSnapshot()).toEqual([{ id: 'claude', trust: 'system' }])
  })

  it('keeps the previous rows when a read fails', async () => {
    const list = vi.fn().mockRejectedValue(new Error('offline'))
    const roster = new AgentPresetRoster({ list })

    roster.load()
    await vi.waitFor(() => expect(list).toHaveBeenCalled())

    expect(roster.getSnapshot()).toEqual([])
  })

  it('shares one in-flight read across concurrent callers', () => {
    const list = vi.fn().mockResolvedValue({ result: { ok: true, value: { presets: [] } } })
    const roster = new AgentPresetRoster({ list })

    roster.load()
    roster.load()

    expect(list).toHaveBeenCalledTimes(1)
  })
})
