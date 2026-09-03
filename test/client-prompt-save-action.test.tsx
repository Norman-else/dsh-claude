// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudePromptView } from '../src/prompts.ts'
import { ClaudePromptSaveAction } from '../src/client/ClaudePromptSaveAction.tsx'
import { PluginRequestError } from '../src/client/plugin-transport.ts'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

let mounted: Root | undefined

afterEach(() => {
  const root = mounted
  mounted = undefined
  if (root !== undefined) act(() => { root.unmount() })
  document.body.replaceChildren()
})

function saved(name: string, body: string): ClaudePromptView {
  return { name, description: body, body, location: `~/.claude/prompts/${name}.md` }
}

function mount({ draft, owned = true, savePrompt, suggestName }: {
  draft?: string
  owned?: boolean
  savePrompt?: (name: string, body: string) => Promise<ClaudePromptView>
  suggestName?: (draft: string, cancel?: AbortSignal) => Promise<string | undefined>
}): void {
  const snapshot: ClaudeClientProjection = { ...EMPTY_CLAUDE_PROJECTION, owned }
  const container = document.createElement('div')
  document.body.append(container)
  mounted = createRoot(container)
  act(() => {
    mounted?.render(<ClaudePromptSaveAction
      t={t}
      useClaudeProjection={<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)}
      {...(draft === undefined ? {} : { input: { draft } })}
      savePrompt={savePrompt ?? (async (name, body) => saved(name, body))}
      suggestName={suggestName ?? (async () => undefined)}
    />)
  })
}

/** The card is portaled, so every query runs against the whole document. */
function trigger(): HTMLButtonElement | null {
  return document.querySelector(`button[aria-label="${en.promptSave}"]`)
}

function card(): HTMLElement | null {
  return document.querySelector('[role="dialog"]')
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(item => item.textContent === label)
}

function click(element: Element | null | undefined): void {
  act(() => { (element as HTMLElement).click() })
}

function field(): HTMLInputElement | null {
  return card()?.querySelector('input') ?? null
}

/** React deduplicates a value it set itself, so typing goes through the
 *  prototype setter the way a real keystroke does. */
function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pointerDown(target: EventTarget | null): void {
  act(() => { target?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
}

function submit(): void {
  act(() => { card()?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

describe('Saving the draft from the composer tool row', () => {
  it('is one tool-row control, unavailable until there is a draft to keep', () => {
    mount({ draft: '   \n ' })

    expect(trigger()?.disabled).toBe(true)
    // Nothing is docked above the composer, so nothing moved to make room.
    expect(card()).toBeNull()
  })

  it('renders nothing in a session this plugin does not own', () => {
    mount({ draft: 'a draft', owned: false })

    expect(trigger()).toBeNull()
  })

  it('opens a named card prefilled from the draft, with both verbs spelled out', () => {
    mount({ draft: '照现有测试风格补单测。\n只覆盖新增分支。' })

    click(trigger())

    expect(field()?.value).toBe('照现有测试风格补单测')
    expect(button(en.promptSaveConfirm)).toBeDefined()
    expect(button(en.promptSaveCancel)).toBeDefined()
  })

  it('lets a Claude-written name replace the derived one when it arrives', async () => {
    mount({ draft: '照现有测试风格补单测。\n只覆盖新增分支。', suggestName: async () => '补单测' })

    click(trigger())
    // The derived name is there immediately; nobody waits on the model.
    expect(field()?.value).toBe('照现有测试风格补单测')

    await act(async () => {})
    expect(field()?.value).toBe('补单测')
  })

  it('leaves a name the user is typing alone, however late the suggestion lands', async () => {
    let settle = (_name: string | undefined): void => {}
    mount({ draft: 'Review this diff', suggestName: async () => await new Promise<string | undefined>((resolve) => { settle = resolve }) })

    click(trigger())
    type(field()!, 'my own name')
    act(() => { settle('a better name') })
    await act(async () => {})

    expect(field()?.value).toBe('my own name')
  })

  it('keeps the derived name when no suggestion can be had', async () => {
    mount({ draft: 'Review this diff', suggestName: async () => undefined })

    click(trigger())
    await act(async () => {})

    expect(field()?.value).toBe('Review this diff')
    // The transient naming notice gives way to the card's own heading.
    expect(card()?.textContent).toContain(en.promptSave)
    expect(card()?.textContent).not.toContain(en.promptSaveNaming)
  })

  it('abandons the suggestion when the card is dismissed', () => {
    const suggestName = vi.fn(async (_draft: string, cancel?: AbortSignal) => {
      await new Promise(resolve => cancel?.addEventListener('abort', resolve))
      return undefined
    })
    mount({ draft: 'Review this diff', suggestName })

    click(trigger())
    click(button(en.promptSaveCancel))

    expect(suggestName.mock.calls[0]?.[1]?.aborted).toBe(true)
  })

  it('survives a pointer inside its own card, which is portaled out of the trigger', () => {
    mount({ draft: 'Review this diff' })

    click(trigger())
    // The Host's build of useDismissOnOutsidePointer takes no portal argument,
    // so leaning on it closed the card on every click in the naming field.
    pointerDown(field())
    expect(card()).not.toBeNull()

    pointerDown(button(en.promptSaveCancel) ?? null)
    expect(card()).not.toBeNull()
  })

  it('closes on a pointer that lands outside both the card and the trigger', () => {
    mount({ draft: 'Review this diff' })

    click(trigger())
    pointerDown(document.body)

    expect(card()).toBeNull()
  })

  it('backs out without writing anything', () => {
    const savePrompt = vi.fn(async (name: string, body: string) => saved(name, body))
    mount({ draft: 'Review this diff', savePrompt })

    click(trigger())
    click(button(en.promptSaveCancel))

    expect(card()).toBeNull()
    expect(savePrompt).not.toHaveBeenCalled()
  })

  it('saves the chosen name with the whole draft, then says where it landed', async () => {
    const savePrompt = vi.fn(async (name: string, body: string) => saved(name, body))
    mount({ draft: 'Review this diff\nand say why', savePrompt })

    click(trigger())
    type(field()!, 'review')
    submit()
    await act(async () => {})

    expect(savePrompt).toHaveBeenCalledWith('review', 'Review this diff\nand say why')
    // The confirmation waits to be dismissed rather than fading on its own.
    expect(card()?.textContent).toContain('Saved as "review"')
    expect(card()?.textContent).toContain('~/.claude/prompts/review.md')

    click(button(en.promptSaveDone))
    expect(card()).toBeNull()
  })

  it('keeps the card open on a name collision, which is the one failure fixed here', async () => {
    const savePrompt = vi.fn(async () => {
      throw new PluginRequestError('http', 'A prompt with that name already exists.', 409, 'name-taken')
    })
    mount({ draft: 'Review this diff', savePrompt })

    click(trigger())
    submit()
    await act(async () => {})

    expect(card()?.textContent).toContain(en.promptSaveExists)
    expect(field()?.value).toBe('Review this diff')
  })

  it('reports any other failure verbatim', async () => {
    const savePrompt = vi.fn(async () => { throw new Error('disk is full') })
    mount({ draft: 'Review this diff', savePrompt })

    click(trigger())
    submit()
    await act(async () => {})

    expect(card()?.textContent).toContain('Could not save: disk is full')
  })
})
