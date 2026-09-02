import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as panelOverlayModule from '../src/client/ClaudePanelOverlay.tsx'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height, right: left + width, bottom: top + height,
    x: left, y: top, toJSON: () => ({}),
  }
}

function shellFixture(initialWorkspace: DOMRect, sidebar: DOMRect, caption?: DOMRect) {
  let workspaceRect = initialWorkspace
  const element = (bounds: () => DOMRect): Element => ({ getBoundingClientRect: bounds }) as Element
  const sidebarElement = element(() => sidebar)
  const workspaceElement = element(() => workspaceRect)
  const detailsElement = element(() => rect(workspaceRect.right, workspaceRect.top, 0, workspaceRect.height))
  const frame = { children: [] as unknown as HTMLCollection } as unknown as HTMLElement
  const overlay = {
    parentElement: frame,
    getBoundingClientRect: () => rect(0, 0, 2_048, 1_107),
  } as unknown as HTMLElement
  const children = [
    ...(caption === undefined ? [] : [element(() => caption)]),
    sidebarElement,
    workspaceElement,
    detailsElement,
    overlay,
  ]
  ;(frame as unknown as { children: Element[] }).children = children
  return {
    frame,
    overlay,
    setWorkspace: (next: DOMRect) => { workspaceRect = next },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Claude diff overlay', () => {
  it('does not cover shell chrome before the workspace boundary is measured', () => {
    const markup = renderToStaticMarkup(createElement(
      panelOverlayModule.ClaudePanelOverlay,
      { onRestore: vi.fn() },
      createElement('div', null, 'diff'),
    ))

    expect(markup).toContain('data-dsh-claude-panel-overlay="true"')
    expect(markup).not.toContain('inset:0')
    expect(markup).toContain('visibility:hidden')
    expect(markup).toContain('pointer-events:none')
  })

  it.each([
    {
      name: 'expanded Windows sidebar and caption',
      fixture: shellFixture(rect(280, 32, 1_768, 1_075), rect(0, 0, 280, 1_107), rect(280, 0, 1_768, 32)),
      expected: { left: 280, top: 32, width: 1_768, height: 1_075 },
    },
    {
      name: 'collapsed Windows sidebar rail and caption',
      fixture: shellFixture(rect(56, 32, 1_992, 1_075), rect(0, 0, 56, 1_107), rect(56, 0, 1_992, 32)),
      expected: { left: 56, top: 32, width: 1_992, height: 1_075 },
    },
    {
      name: 'web frame with a zero-width collapsed sidebar',
      fixture: shellFixture(rect(0, 0, 2_048, 1_107), rect(0, 0, 0, 1_107)),
      expected: { left: 0, top: 0, width: 2_048, height: 1_107 },
    },
  ])('uses only the conversation workspace with $name', ({ fixture, expected }) => {
    expect(panelOverlayModule.workspaceBounds(fixture.overlay)).toEqual(expected)
  })

  it('tracks the workspace as Details closes and disconnects every observer on cleanup', () => {
    const fixture = shellFixture(rect(280, 32, 1_288, 1_075), rect(0, 0, 280, 1_107), rect(280, 0, 1_768, 32))
    let resize: (() => void) | undefined
    const observeResize = vi.fn()
    const disconnectResize = vi.fn()
    class ResizeObserverFake {
      constructor(callback: () => void) { resize = callback }
      observe = observeResize
      disconnect = disconnectResize
    }
    const disconnectMutation = vi.fn()
    class MutationObserverFake {
      constructor(_callback: () => void) {}
      observe = vi.fn()
      disconnect = disconnectMutation
    }
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal('ResizeObserver', ResizeObserverFake)
    vi.stubGlobal('MutationObserver', MutationObserverFake)
    vi.stubGlobal('window', { addEventListener, removeEventListener })
    const observeWorkspaceBounds = Reflect.get(panelOverlayModule, 'observeWorkspaceBounds') as (
      (overlay: HTMLElement, listener: (bounds: unknown) => void) => () => void
    ) | undefined
    const listener = vi.fn()

    expect(observeWorkspaceBounds).toBeTypeOf('function')
    const dispose = observeWorkspaceBounds?.(fixture.overlay, listener)
    expect(listener).toHaveBeenLastCalledWith({ left: 280, top: 32, width: 1_288, height: 1_075 })

    fixture.setWorkspace(rect(280, 32, 1_768, 1_075))
    resize?.()
    expect(listener).toHaveBeenLastCalledWith({ left: 280, top: 32, width: 1_768, height: 1_075 })

    dispose?.()
    expect(disconnectResize).toHaveBeenCalledOnce()
    expect(disconnectMutation).toHaveBeenCalledOnce()
    expect(removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('leaves Escape to an open modal without restoring the maximized diff', () => {
    const shouldRestoreFromEscape = Reflect.get(panelOverlayModule, 'shouldRestoreFromEscape') as (
      (event: Pick<KeyboardEvent, 'key'>, root: Pick<Document, 'querySelector'>) => boolean
    ) | undefined
    const modalRoot = { querySelector: vi.fn(() => ({ role: 'dialog' })) }
    const clearRoot = { querySelector: vi.fn(() => null) }

    expect(shouldRestoreFromEscape).toBeTypeOf('function')
    expect(shouldRestoreFromEscape?.({ key: 'Escape' }, modalRoot)).toBe(false)
    expect(shouldRestoreFromEscape?.({ key: 'Escape' }, clearRoot)).toBe(true)
    expect(shouldRestoreFromEscape?.({ key: 'Enter' }, clearRoot)).toBe(false)
  })
})
