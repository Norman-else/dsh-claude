// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestReviewThread } from '../src/pr-feedback.ts'
import { ReviewThreadCard } from '../src/client/ReviewThreadCard.tsx'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replaceAll(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

const thread: PullRequestReviewThread = {
  id: 'T1',
  path: 'src/a.ts',
  line: 3,
  side: 'new',
  resolved: false,
  outdated: false,
  comments: [
    { id: 1, path: 'src/a.ts', line: 3, side: 'new', author: 'mercoder-dev', body: 'Concurrent withdrawals report changes twice', url: 'https://github.com/x#1', createdAt: '2026-08-28T17:00:00Z' },
  ],
}

let mounted: { root: Root; container: HTMLElement } | undefined

function mount(onReply = vi.fn(async () => undefined)): { container: HTMLElement; onReply: typeof onReply } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  act(() => {
    root.render(<ReviewThreadCard
      thread={thread}
      t={t}
      now={Date.parse('2026-08-28T21:00:00Z')}
      suggest={vi.fn(async () => [])}
      onReply={onReply}
      onResolvedChange={vi.fn(async () => undefined)}
    />)
  })
  return { container, onReply }
}

function click(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (button === undefined) throw new Error(`no "${label}" button`)
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

afterEach(() => {
  if (mounted === undefined) return
  const { root, container } = mounted
  act(() => { root.unmount() })
  container.remove()
  mounted = undefined
})

describe('review thread reply composer', () => {
  it('opens as its own region rather than trailing the comment above it', () => {
    const { container } = mount()
    click(container, 'Reply')

    const composer = container.querySelector('[data-review-reply]')
    expect(composer).not.toBeNull()
    // A rule and a caption separate the box from the comment it answers.
    expect(composer?.getAttribute('style')).toContain('border-top')
    expect(composer?.textContent).toContain('Reply to @mercoder-dev')
    expect(container.querySelector('textarea')).not.toBeNull()
  })

  it('sends the draft to the thread and closes', async () => {
    const { container, onReply } = mount()
    click(container, 'Reply')
    const area = container.querySelector('textarea')
    if (area === null) throw new Error('no textarea')

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setter?.call(area, 'Thanks, verified')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { click(container, 'Send reply') })

    expect(onReply).toHaveBeenCalledWith('Thanks, verified')
    expect(container.querySelector('textarea')).toBeNull()
  })
})
