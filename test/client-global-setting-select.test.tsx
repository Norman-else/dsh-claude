import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GlobalSettingSelect, SETTING_COPY, SettingHint, type GlobalSettingView } from '../src/client/ClaudeCodeSettings.tsx'
import { en } from '../src/client/locales.ts'

const setting: GlobalSettingView = {
  key: 'outputStyle',
  kind: 'select',
  value: 'concise',
  effect: 'new-session',
  options: [
    { value: '', label: 'Default', source: 'built-in' },
    { value: 'concise', label: 'Concise', source: 'built-in' },
  ],
}

describe('GlobalSettingSelect', () => {
  it('renders a themed listbox trigger instead of a native select', () => {
    const markup = renderToStaticMarkup(
      <GlobalSettingSelect setting={setting} disabled={false} onChange={vi.fn()} />,
    )

    expect(markup).toContain('aria-haspopup="listbox"')
    expect(markup).toContain('Concise')
    expect(markup).not.toContain('<select')
  })

  it('disables the trigger while a settings request is pending', () => {
    const markup = renderToStaticMarkup(
      <GlobalSettingSelect setting={setting} disabled onChange={vi.fn()} />,
    )

    expect(markup).toContain('disabled=""')
  })
})

describe('SettingHint', () => {
  it('carries the effect note in the accessible name rather than on the page', () => {
    const markup = renderToStaticMarkup(<SettingHint text={en.maxProcessesEffect} label={en.settingHint} />)
    expect(markup).toContain('role="note"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain(`aria-label="${en.settingHint}: ${en.maxProcessesEffect}"`)
    // The note itself stays hidden until the tooltip opens.
    expect(markup).not.toContain('>The process limit')
  })

  it('gives every editable setting a label and a hint', () => {
    for (const key of ['outputStyle', 'worktreeBranchPrefix', 'maxProcesses', 'idleTimeoutMinutes']) {
      const copy = SETTING_COPY[key]
      expect(copy, key).toBeDefined()
      expect(en[copy!.label], key).toBeTruthy()
      expect(en[copy!.hint], key).toBeTruthy()
    }
  })
})
