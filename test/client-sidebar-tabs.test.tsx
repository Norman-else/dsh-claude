// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { registerClaudeSidebarTabs } from '../src/client/sidebar-tabs.tsx'

function context() {
  const registrations: { name: string; key?: string; inject?: (sessionId: string) => Record<string, unknown> }[] = []
  const dispose = (): void => {}
  const sidebarRight = { openTabIn: vi.fn(), closeIn: vi.fn(), toggleExpanded: vi.fn() }
  const ctx = {
    effect(register: () => unknown) { register() },
    sidebarRightTabs: { register: () => dispose },
    sidebarRight,
    slots: {
      inject(_name: string, register: () => unknown) { register() },
      register(options: { name: string; key?: string; inject?: (sessionId: string) => Record<string, unknown> }) {
        registrations.push(options)
        return dispose
      },
    },
  }
  return { ctx, registrations, sidebarRight }
}

describe('Claude sidebar tabs', () => {
  it('maximizes through the Host fullscreen toggle, never by folding the column to its rail', () => {
    const { ctx, registrations, sidebarRight } = context()
    registerClaudeSidebarTabs(ctx as never, {
      t: ((key: string) => key) as never,
      namespace: 'settings.claude-code',
      diffFace: () => ({}),
      overviewFace: () => undefined,
    })
    const face = registrations.find(entry => entry.key === 'claude-diff')?.inject?.('session-1') as { toggleMaximized(): void }
    // The Host draws its own fullscreen button in the sidebar chrome; that is
    // the one action that flips presentation, and it is not on the service.
    const chrome = document.createElement('button')
    chrome.setAttribute('data-sidebar-right-mode', 'fullscreen')
    const pressed = vi.fn()
    chrome.addEventListener('click', pressed)
    document.body.append(chrome)
    face.toggleMaximized()
    expect(pressed).toHaveBeenCalledTimes(1)
    expect(sidebarRight.toggleExpanded).not.toHaveBeenCalled()
    chrome.remove()
    // Without the chrome on screen there is nothing to press, and still no collapse.
    face.toggleMaximized()
    expect(sidebarRight.toggleExpanded).not.toHaveBeenCalled()
  })
})
