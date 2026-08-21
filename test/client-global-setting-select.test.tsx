import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GlobalSettingSelect, type GlobalSettingView } from '../src/client/ClaudeCodeSettings.tsx'

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
