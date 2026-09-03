// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudePromptRefineAction } from '../src/client/ClaudePromptRefineAction.tsx'
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

/** The tool row re-renders its entries with the new draft after every write,
 *  so the harness feeds the draft back the way the owner does. */
function mount({ draft = '', owned = true, replaceDraft, notify, refine }: {
  draft?: string
  owned?: boolean
  replaceDraft?: (text: string) => void
  notify?: (level: 'info' | 'error', text: string) => void
  refine?: (draft: string, cancel?: AbortSignal) => Promise<string>
}): { render: (next: string) => void } {
  const snapshot: ClaudeClientProjection = { ...EMPTY_CLAUDE_PROJECTION, owned }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted = root
  const render = (next: string): void => {
    act(() => {
      root.render(<ClaudePromptRefineAction
        t={t}
        useClaudeProjection={<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)}
        input={{ draft: next }}
        {...(replaceDraft === undefined ? {} : { replaceDraft })}
        {...(notify === undefined ? {} : { notify })}
        refine={refine ?? (async () => 'rewritten')}
      />)
    })
  }
  render(draft)
  return { render }
}

function trigger(): HTMLButtonElement | null {
  return document.querySelector('button')
}

function click(element: Element | null): void {
  act(() => { (element as HTMLElement).click() })
}

describe('Rewriting the draft from the composer tool row', () => {
  it('is unavailable until there is a draft to rewrite', () => {
    mount({ draft: '  \n ', replaceDraft: vi.fn() })

    expect(trigger()?.disabled).toBe(true)
    expect(trigger()?.getAttribute('aria-label')).toBe(en.promptRefine)
  })

  it('renders nothing when the Host exposes no way to write the draft back', () => {
    mount({ draft: 'a draft' })

    expect(trigger()).toBeNull()
  })

  it('renders nothing in a session this plugin does not own', () => {
    mount({ draft: 'a draft', owned: false, replaceDraft: vi.fn() })

    expect(trigger()).toBeNull()
  })

  it('replaces the draft with the rewrite', async () => {
    const replaceDraft = vi.fn()
    const refine = vi.fn(async () => 'a clearer prompt')
    const { render } = mount({ draft: 'fix the thing', replaceDraft, refine })

    click(trigger())
    // Busy while it runs, so a second press cannot start a second rewrite.
    expect(trigger()?.disabled).toBe(true)
    expect(trigger()?.getAttribute('aria-label')).toBe(en.promptRefineBusy)
    await act(async () => {})

    expect(refine).toHaveBeenCalledWith('fix the thing', expect.anything())
    expect(replaceDraft).toHaveBeenCalledWith('a clearer prompt')
    render('a clearer prompt')
    expect(trigger()?.getAttribute('aria-label')).toBe(en.promptRefineUndo)
  })

  it('offers the original back, because setDraft is not an undoable step', async () => {
    const replaceDraft = vi.fn()
    const { render } = mount({ draft: 'fix the thing', replaceDraft, refine: async () => 'a clearer prompt' })

    click(trigger())
    await act(async () => {})
    render('a clearer prompt')
    click(trigger())

    expect(replaceDraft).toHaveBeenLastCalledWith('fix the thing')
  })

  it('withdraws the undo once the rewrite has been edited, since that is no longer what it would restore', async () => {
    const { render } = mount({ draft: 'fix the thing', replaceDraft: vi.fn(), refine: async () => 'a clearer prompt' })

    click(trigger())
    await act(async () => {})
    render('a clearer prompt, and also this')

    expect(trigger()?.getAttribute('aria-label')).toBe(en.promptRefine)
  })

  it('reports a failure on the composer notice channel and leaves the draft alone', async () => {
    const replaceDraft = vi.fn()
    const notify = vi.fn()
    mount({ draft: 'fix the thing', replaceDraft, notify, refine: async () => { throw new Error('claude is unavailable') } })

    click(trigger())
    await act(async () => {})

    expect(replaceDraft).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('error', 'Could not rewrite: claude is unavailable')
    expect(trigger()?.disabled).toBe(false)
  })
})
