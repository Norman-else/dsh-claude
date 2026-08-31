import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GlobalSettingSelect, SETTING_COPY, SETTING_OPTION_COPY, SettingHint, settingOptionLabel, type GlobalSettingView } from '../src/client/ClaudeCodeSettings.tsx'
import { en } from '../src/client/locales.ts'
import * as styles from '../src/client/styles.ts'

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

  it('draws the chevron as geometry, not as a text glyph nudged into place', () => {
    const markup = renderToStaticMarkup(
      <GlobalSettingSelect setting={setting} disabled={false} onChange={vi.fn()} />,
    )

    // U+2304 carries its ink below the centre of its em box, so a text
    // chevron only looks centred with a hand-tuned nudge -- and the nudge
    // cannot survive the 180-degree flip, which moves the ink to the other
    // side. Geometry centred in its own viewBox needs no compensation.
    expect(markup).toContain('<svg')
    expect(markup).not.toContain('⌄')
    expect(markup).not.toContain('translateY')
  })

  it('keeps a focus ring of its own so the browser default never shows through', () => {
    const markup = renderToStaticMarkup(
      <GlobalSettingSelect setting={setting} disabled={false} onChange={vi.fn()} />,
    )

    // Focus and open are separate states: picking an option closes the menu
    // while the button keeps focus, and an unstyled :focus-visible leaves the
    // UA ring -- white on a dark theme -- outside the trigger's radius.
    expect(markup).toContain(styles.settingSelectTriggerClass)
    expect(markup).toContain(':focus-visible')
    expect(markup).toContain('outline: none')
  })

  it('disables the trigger while a settings request is pending', () => {
    const markup = renderToStaticMarkup(
      <GlobalSettingSelect setting={setting} disabled onChange={vi.fn()} />,
    )

    expect(markup).toContain('disabled=""')
  })
})

describe('settingOptionLabel', () => {
  const t = (key: keyof typeof en): string => en[key]

  it('translates the option vocabularies this plugin owns', () => {
    expect(settingOptionLabel('renderer', { value: 'native', label: 'native', source: 'built-in' }, t as never))
      .toBe(en.rendererNative)
    for (const key of Object.values(SETTING_OPTION_COPY)) expect(en[key]).toBeTruthy()
  })

  it('shows a machine-discovered name exactly as the route reported it', () => {
    expect(settingOptionLabel('outputStyle', { value: 'Code Reviewer', label: 'Code Reviewer', source: 'user' }, t as never))
      .toBe('Code Reviewer')
  })

  it('renders the translated label in the listbox trigger', () => {
    const markup = renderToStaticMarkup(
      <GlobalSettingSelect
        setting={{
          key: 'renderer',
          kind: 'select',
          value: 'native',
          effect: 'restart',
          options: [
            { value: 'plugin', label: 'plugin', source: 'built-in' },
            { value: 'native', label: 'native', source: 'built-in' },
          ],
        }}
        disabled={false}
        labelFor={option => settingOptionLabel('renderer', option, t as never)}
        onChange={vi.fn()}
      />,
    )
    expect(markup).toContain(en.rendererNative)
    expect(markup).not.toContain('>native<')
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
    for (const key of ['outputStyle', 'renderer', 'worktreeBranchPrefix', 'maxProcesses', 'idleTimeoutMinutes']) {
      const copy = SETTING_COPY[key]
      expect(copy, key).toBeDefined()
      expect(en[copy!.label], key).toBeTruthy()
      expect(en[copy!.hint], key).toBeTruthy()
    }
  })
})
