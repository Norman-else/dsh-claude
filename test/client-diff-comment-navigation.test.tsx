// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeDiffPanel } from '../src/client/ClaudeDiffPanel.tsx'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replaceAll(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1',
  '+const b = 2',
  ' export {}',
  'diff --git a/src/b.ts b/src/b.ts',
  '@@ -1,2 +1,3 @@',
  ' const c = 3',
  '+const d = 4',
  ' export {}',
].join('\n')

const projection: ClaudeClientProjection = {
  ...EMPTY_CLAUDE_PROJECTION,
  owned: true,
  repository: {
    status: 'ready',
    cwd: '/repo',
    root: '/repo',
    branch: 'feature',
    diff: { additions: 2, deletions: 0, files: 2, truncated: false, patch: PATCH },
  },
  reviewComments: [
    { id: 'local-1', path: 'src/a.ts', line: 2, side: 'new', text: 'first' },
    { id: 'local-2', path: 'src/b.ts', line: 2, side: 'new', text: 'second' },
  ],
}

let mounted: { root: Root; container: HTMLElement } | undefined

function mount(): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  act(() => {
    root.render(<ClaudeDiffPanel
      t={t}
      sessionId="session-1"
      maximized={false}
      closeDetails={vi.fn()}
      toggleMaximized={vi.fn()}
      useClaudeProjection={(<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(projection)) as never}
    />)
  })
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label)
  if (found === undefined) throw new Error(`no "${label}" button`)
  return found
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (mounted === undefined) return
  const { root, container } = mounted
  act(() => { root.unmount() })
  container.remove()
  mounted = undefined
})

describe('diff panel file sections', () => {
  it('opens and closes every file at once from the summary row', () => {
    const container = mount()
    const sections = (): boolean[] => [...container.querySelectorAll('[aria-expanded]')]
      .filter(item => item.querySelector('[data-diff-file-chevron]') !== null)
      .map(item => item.getAttribute('aria-expanded') === 'true')
    // Only the first file starts open, so the control offers to open the rest.
    expect(sections()).toEqual([true, false])

    act(() => { button(container, en.diffExpandAll).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(sections()).toEqual([true, true])

    act(() => { button(container, en.diffCollapseAll).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(sections()).toEqual([false, false])
  })

  it('gives the expander an icon big enough to hit', () => {
    const container = mount()
    const chevron = container.querySelector('[data-diff-file-chevron] svg')
    expect(chevron).not.toBeNull()
    // The bare "›" glyph rendered at 11px was the complaint.
    expect(chevron?.getAttribute('width')).toBe('14')
  })
})

describe('diff panel comment navigation', () => {
  it('walks to the next comment, opening the file that holds it', () => {
    const container = mount()
    // The second file starts collapsed, so its comment is not even rendered.
    expect(container.querySelector('[data-review-target="comment:local-2"]')).toBeNull()
    expect(container.textContent).toContain('1/2')

    act(() => { button(container, en.diffCommentNext).dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const second = container.querySelector('[data-review-target="comment:local-2"]')
    expect(second).not.toBeNull()
    expect(second?.getAttribute('data-review-active')).toBe('true')
    expect(second?.scrollIntoView).toHaveBeenCalled()
    expect(container.textContent).toContain('2/2')
  })

  it('wraps around and walks backwards', () => {
    const container = mount()
    act(() => { button(container, en.diffCommentPrevious).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('2/2')

    act(() => { button(container, en.diffCommentNext).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('1/2')
  })

  it('answers n and p, but never while the reader is typing', () => {
    const container = mount()

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })) })
    expect(container.textContent).toContain('2/2')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true })) })
    expect(container.textContent).toContain('1/2')

    // A composer swallows the letter: typing "n" in a reply must not navigate.
    const area = document.createElement('textarea')
    container.append(area)
    act(() => { area.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })) })
    expect(container.textContent).toContain('1/2')

    // Nor does a shortcut that carries a modifier.
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true })) })
    expect(container.textContent).toContain('1/2')
  })
})
