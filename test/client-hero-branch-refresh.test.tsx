// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { cloneElement } = await import('react')
  return {
    IconBranchOutline16: () => <svg data-icon="branch" />,
    IconCheckOutline14: () => <svg data-icon="check" />,
    IconChevronDownOutline14: () => <svg data-icon="chevron-down" />,
    IconRefreshOutline14: () => <svg data-icon="refresh" />,
    IconSearchOutline16: () => <svg data-icon="search" />,
    Tooltip: ({ label, children }: { label: string; children: React.ReactElement }) =>
      cloneElement(children, { 'data-tooltip': label } as Record<string, unknown>),
  }
})

import { ClaudeHeroRepositoryCapsule } from '../src/client/ClaudeHeroRepositoryControls.tsx'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true
// jsdom has no layout, so the menu's scroll-into-view of the active row throws.
Element.prototype.scrollIntoView = vi.fn()

let mounted: { root: Root; container: HTMLElement } | undefined

function mount(props: Partial<Parameters<typeof ClaudeHeroRepositoryCapsule>[0]> = {}): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  act(() => {
    root.render(<ClaudeHeroRepositoryCapsule
      branches={['main']}
      selected="main"
      worktree={false}
      busy={false}
      menuOpen
      worktreeLabel="Worktree"
      searchPlaceholder="Search branches"
      emptySearchLabel="No matching branches"
      refreshLabel="Refresh remote branches"
      refreshing={false}
      onMenuOpenChange={vi.fn()}
      onRefresh={vi.fn()}
      onSelect={vi.fn()}
      onWorktreeChange={vi.fn()}
      {...props}
    />)
  })
  return container
}

function refreshControl(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh remote branches"]')
  if (button === null) throw new Error('the refresh control is missing')
  return button
}

afterEach(() => {
  if (mounted === undefined) return
  const { root, container } = mounted
  act(() => { root.unmount() })
  container.remove()
  mounted = undefined
})

describe('branch menu refresh control', () => {
  it('runs the refresh handler on a real click', () => {
    const onRefresh = vi.fn()
    const container = mount({ onRefresh })

    act(() => { refreshControl(container).dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('answers the pointer the way every other control in the capsule does', () => {
    const container = mount()
    const button = refreshControl(container)
    const resting = button.getAttribute('style')

    act(() => { button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })

    expect(button.getAttribute('style')).not.toBe(resting)
  })
})
