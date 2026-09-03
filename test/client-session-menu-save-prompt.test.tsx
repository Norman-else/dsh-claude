// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSessionMenu } from '../src/client/ClaudeSessionMenu.tsx'
import { PluginRequestError } from '../src/client/plugin-transport.ts'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

let mounted: { root: Root; container: HTMLElement } | undefined

afterEach(() => {
  if (mounted === undefined) return
  const { root, container } = mounted
  mounted = undefined
  act(() => { root.unmount() })
  container.remove()
})

function mount({ draft, savePrompt }: {
  draft: string
  savePrompt?: (name: string, body: string) => Promise<void>
}): HTMLElement {
  const snapshot: ClaudeClientProjection = { ...EMPTY_CLAUDE_PROJECTION, owned: true }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  act(() => {
    root.render(<ClaudeSessionMenu
      t={t}
      sessionId="session-1"
      useClaudeProjection={<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)}
      draftOf={() => draft}
      openInEditor={async () => {}}
      savePrompt={savePrompt ?? (async () => {})}
    />)
  })
  return container
}

function click(element: Element | null | undefined): void {
  act(() => { (element as HTMLElement).click() })
}

/** The trigger, then the save row inside the card it opens. */
function openSaveRow(container: HTMLElement): HTMLElement {
  click(container.querySelector('.dsh-claude-header-menu'))
  const rows = [...container.querySelectorAll('.dsh-claude-header-menu-item')]
  const row = rows.find(item => item.textContent === en.promptSave)
  expect(row).toBeDefined()
  return row as HTMLElement
}

function nameField(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('.dsh-claude-header-menu-input')
}

/** React deduplicates a value it set itself, so typing goes through the
 *  prototype setter the way a real keystroke does. */
function type(field: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit(container: HTMLElement): void {
  act(() => { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

describe('Saving the composer draft as a prompt from the session menu', () => {
  it('opens a naming field prefilled from the draft', () => {
    const container = mount({ draft: '照现有测试风格补单测。\n只覆盖新增分支。' })

    click(openSaveRow(container))

    expect(nameField(container)?.value).toBe('照现有测试风格补单测')
  })

  it('saves the name the user settles on together with the whole draft', async () => {
    const savePrompt = vi.fn(async () => {})
    const container = mount({ draft: 'Review this diff\nand say why', savePrompt })

    click(openSaveRow(container))
    type(nameField(container)!, 'review')
    submit(container)
    await act(async () => {})

    expect(savePrompt).toHaveBeenCalledWith('review', 'Review this diff\nand say why')
    // A saved prompt closes the menu; the outcome rides the toast, which the
    // primitive portals to the document body.
    expect(nameField(container)).toBeNull()
    expect(document.body.textContent).toContain('Saved as "review"')
  })

  it('says there is nothing to save rather than writing an empty prompt', () => {
    const savePrompt = vi.fn(async () => {})
    const container = mount({ draft: '   \n ', savePrompt })

    click(openSaveRow(container))

    expect(nameField(container)).toBeNull()
    expect(container.textContent).toContain(en.promptSaveEmpty)
    expect(savePrompt).not.toHaveBeenCalled()
  })

  it('keeps the field open on a name collision, which is the one failure the user fixes here', async () => {
    const savePrompt = vi.fn(async () => {
      throw new PluginRequestError('http', 'A prompt with that name already exists.', 409, 'name-taken')
    })
    const container = mount({ draft: 'Review this diff', savePrompt })

    click(openSaveRow(container))
    submit(container)
    await act(async () => {})

    expect(container.textContent).toContain(en.promptSaveExists)
    expect(nameField(container)?.value).toBe('Review this diff')
  })

  it('reports any other failure verbatim', async () => {
    const savePrompt = vi.fn(async () => { throw new Error('disk is full') })
    const container = mount({ draft: 'Review this diff', savePrompt })

    click(openSaveRow(container))
    submit(container)
    await act(async () => {})

    expect(container.textContent).toContain('Could not save: disk is full')
  })
})

describe('A session menu with no composer to read', () => {
  it('omits the save row entirely rather than offering an action that cannot work', () => {
    const snapshot: ClaudeClientProjection = { ...EMPTY_CLAUDE_PROJECTION, owned: true }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted = { root, container }
    act(() => {
      root.render(<ClaudeSessionMenu
        t={t}
        sessionId="session-1"
        useClaudeProjection={<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)}
        openInEditor={async () => {}}
      />)
    })

    click(container.querySelector('.dsh-claude-header-menu'))
    expect(container.textContent).not.toContain(en.promptSave)
  })
})
