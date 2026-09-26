// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudePermissionSelect } from '../src/client/ClaudePermissionSelect.tsx'
import type { ClaudePermissionModeOutcome } from '../src/client/permission-mode-api.ts'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'
import type { ClaudePermissionMode } from '../src/permission-mode.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The Host 0.1.7 Tooltip measures its bubble with a ResizeObserver, which
// jsdom does not ship; an inert one lets the bubble mount.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

let mounted: Root | undefined

afterEach(() => {
  const root = mounted
  mounted = undefined
  if (root !== undefined) act(() => { root.unmount() })
  document.body.replaceChildren()
})

function outcome(mode: ClaudePermissionMode, hostSynced = true): ClaudePermissionModeOutcome {
  return { mode, sandbox: mode === 'plan' ? 'read-only' : mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write', hostSynced }
}

function mount({ owned = true, selector = 'plugin', mode, locked = false, autoSupported, running = false, setMode, notify }: {
  owned?: boolean
  /** `null` leaves the field off the snapshot, as before the first carrier line. */
  selector?: 'plugin' | 'native' | null
  mode?: ClaudePermissionMode
  locked?: boolean
  autoSupported?: boolean
  running?: boolean
  setMode?: (mode: ClaudePermissionMode) => Promise<ClaudePermissionModeOutcome>
  notify?: (level: 'info' | 'error', text: string) => void
}): { setMode: ReturnType<typeof vi.fn> } {
  const snapshot: ClaudeClientProjection = {
    ...EMPTY_CLAUDE_PROJECTION,
    owned,
    ...(selector === null ? {} : { permissionSelector: selector }),
    ...(mode === undefined ? {} : { permissionMode: { mode, locked, ...(autoSupported === undefined ? {} : { autoSupported }) } }),
  }
  const set = vi.fn(setMode ?? (async (next: ClaudePermissionMode) => outcome(next)))
  const container = document.createElement('div')
  document.body.append(container)
  mounted = createRoot(container)
  act(() => {
    mounted?.render(<ClaudePermissionSelect
      t={t}
      setMode={set}
      {...(notify === undefined ? {} : { notify })}
      useClaudeProjection={<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)}
      useSession={<S,>(selector: (value: { readonly running: boolean }) => S): S => selector({ running })}
    />)
  })
  return { setMode: set }
}

function trigger(): HTMLButtonElement | null {
  return document.querySelector('.dshClaudePermissionSelectTrigger')
}

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function click(element: Element | null | undefined): void {
  act(() => { (element as HTMLElement).click() })
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('Claude permission select', () => {
  it('renders nothing for a session another preset drives', () => {
    mount({ owned: false, mode: 'plan' })
    expect(trigger()).toBeNull()
  })

  it('stands down under the Host selector, and before the setting is known', () => {
    // Nothing rendered means the Host's own control shows: the hiding rule
    // keys on this element's presence.
    mount({ selector: 'native', mode: 'acceptEdits' })
    expect(trigger()).toBeNull()
    act(() => { mounted?.unmount() })
    mounted = undefined
    document.body.replaceChildren()
    mount({ selector: null, mode: 'acceptEdits' })
    expect(trigger()).toBeNull()
  })

  it('shows the current mode with its glyph and lists every Claude Code mode with one', () => {
    mount({ mode: 'acceptEdits' })
    const button = trigger()
    expect(button?.textContent).toBe(en.permissionModeAcceptEdits)
    expect(button?.getAttribute('aria-label')).toBe(`Permission mode: ${en.permissionModeAcceptEdits}`)
    expect(button?.querySelector('.dshClaudePermissionSelectIcon svg')).not.toBeNull()
    // No native tooltip anywhere: the Host draws its own bubbles, and so does this.
    expect(button?.hasAttribute('title')).toBe(false)
    click(button)
    const rows = items()
    expect(rows.map(row => row.querySelector('.dshClaudePermissionSelectRowName')?.textContent)).toEqual([
      en.permissionModePlan, en.permissionModeDefault, en.permissionModeAcceptEdits, en.permissionModeDontAsk, en.permissionModeAuto, en.permissionModeBypass,
    ])
    expect(rows.map(row => row.querySelector('.dshClaudePermissionSelectRowHint')?.textContent)).toContain(en.permissionModeAutoHint)
    for (const row of rows) {
      expect(row.querySelector('svg')).not.toBeNull()
      expect(row.querySelector('[title]')).toBeNull()
    }
  })

  it('greys auto out with the reason when the catalog says the model lacks it', () => {
    const { setMode } = mount({ mode: 'default', autoSupported: false })
    click(trigger())
    const auto = items().find(row => row.querySelector('.dshClaudePermissionSelectRowName')?.textContent === en.permissionModeAuto)
    expect(auto?.querySelector('.dshClaudePermissionSelectRowHint')?.textContent).toBe(en.permissionModeAutoUnsupported)
    click(auto)
    expect(setMode).not.toHaveBeenCalled()
  })

  it('shows the Host tooltip bubble for the current mode on hover, not a native title', async () => {
    vi.useFakeTimers()
    try {
      mount({ mode: 'plan' })
      // React synthesises onMouseEnter from the bubbling mouseover.
      act(() => { trigger()?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.body.textContent).toContain(en.permissionModePlanHint)
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits a pick, shows it at once, and tells the user when the Host kept its preset', async () => {
    const notify = vi.fn()
    const { setMode } = mount({ mode: 'plan', notify, setMode: async next => outcome(next, false) })
    click(trigger())
    click(items().find(row => row.querySelector('.dshClaudePermissionSelectRowName')?.textContent === en.permissionModeDefault))
    expect(setMode).toHaveBeenCalledWith('default')
    expect(trigger()?.textContent).toBe(en.permissionModeDefault)
    await settle()
    expect(notify).toHaveBeenCalledWith('info', en.permissionModeHostKept)
  })

  it('drops back to the reported mode when the Host refuses the pick', async () => {
    const notify = vi.fn()
    mount({ mode: 'plan', notify, setMode: async () => { throw new Error('session-busy') } })
    click(trigger())
    click(items().find(row => row.querySelector('.dshClaudePermissionSelectRowName')?.textContent === en.permissionModeDontAsk))
    await settle()
    expect(trigger()?.textContent).toBe(en.permissionModePlan)
    expect(notify).toHaveBeenCalledWith('error', 'Could not switch the permission mode: session-busy')
  })

  it('asks for an acknowledged confirmation before bypassing permissions', async () => {
    const { setMode } = mount({ mode: 'default' })
    click(trigger())
    click(items().find(row => row.querySelector('.dshClaudePermissionSelectRowName')?.textContent === en.permissionModeBypass))
    expect(setMode).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')
    expect(dialog?.textContent).toContain(en.permissionBypassTitle)
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === en.permissionBypassConfirm)
    expect(confirm?.disabled).toBe(true)
    const acknowledge = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"], [role="alertdialog"] input[type="checkbox"]')
    click(acknowledge)
    click([...document.querySelectorAll('button')].find(button => button.textContent === en.permissionBypassConfirm))
    expect(setMode).toHaveBeenCalledWith('bypassPermissions')
    await settle()
  })

  it('locks while a turn runs, from either the Host or the projection', () => {
    mount({ mode: 'default', running: true })
    expect(trigger()?.disabled).toBe(true)
    expect(trigger()?.hasAttribute('title')).toBe(false)
    act(() => { mounted?.unmount() })
    mounted = undefined
    document.body.replaceChildren()
    mount({ mode: 'default', locked: true })
    expect(trigger()?.disabled).toBe(true)
  })
})
