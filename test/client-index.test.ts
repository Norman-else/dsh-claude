import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

const resizeLifecycle = vi.hoisted(() => ({
  events: [] as string[],
  enable: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../src/client/details-resize.ts', () => ({
  enableExpandedDetailsResize: (): (() => void) => {
    resizeLifecycle.events.push('resize-enable')
    resizeLifecycle.enable()
    return (): void => {
      resizeLifecycle.events.push('resize-dispose')
      resizeLifecycle.dispose()
    }
  },
}))

describe('Claude client slot registration', () => {
  beforeEach(() => {
    resizeLifecycle.events.length = 0
    resizeLifecycle.enable.mockClear()
    resizeLifecycle.dispose.mockClear()
  })

  it('keeps repository status ahead of DSH terminal queue dock', () => {
    const registrations: Array<{ readonly name: string; readonly id?: string; readonly order?: number }> = []
    const dispose = (): void => {}
    const ctx = {
      effect(register: () => unknown) {
        register()
      },
      get() {
        return undefined
      },
      locale: {
        register: () => dispose,
        bind: () => (key: string) => key,
      },
      inputTriggers: {
        registerSource: () => dispose,
      },
      conversationEvents: {
        register: () => dispose,
      },
      slots: {
        onEntryError: () => dispose,
        inject(_name: string, register: () => unknown) {
          register()
        },
        register(options: { readonly name: string; readonly id?: string; readonly order?: number }) {
          registrations.push(options)
          return dispose
        },
      },
    }

    apply(ctx as never)

    const repositoryStatus = registrations.find(entry => entry.id === 'claude-repository-status')
    expect(repositoryStatus).toBeDefined()
    expect(repositoryStatus?.order).toBeLessThan(20)
  })

  it('registers the maximized diff as an identified shell overlay', () => {
    interface Registration {
      readonly name: string
      readonly id?: string
      readonly inject?: (...args: unknown[]) => unknown
      readonly component?: () => unknown
      active: boolean
    }
    const registrations: Registration[] = []
    let reportEntryError: ((key: string, entry: { readonly options: { readonly id?: string } }) => void) | undefined
    const dispose = (): void => {}
    const layout = {
      openDetails: vi.fn(() => resizeLifecycle.events.push('layout-open')),
      closeDetails: vi.fn(() => resizeLifecycle.events.push('layout-close')),
    }
    const ctx = {
      effect(register: () => unknown) {
        register()
      },
      get(name: string) {
        return name === 'layout' ? layout : undefined
      },
      locale: {
        register: () => dispose,
        bind: () => (key: string) => key,
      },
      inputTriggers: {
        registerSource: () => dispose,
      },
      conversationEvents: {
        register: () => dispose,
      },
      slots: {
        onEntryError(callback: typeof reportEntryError) {
          reportEntryError = callback
          return dispose
        },
        inject(_name: string, register: () => unknown) {
          register()
        },
        register(options: Omit<Registration, 'active' | 'component'>, component?: () => unknown) {
          if (options.name === 'shell.overlay' && options.id === undefined) {
            throw new Error('List slot registrations require an id')
          }
          const registration = { ...options, component, active: true }
          registrations.push(registration)
          return (): void => {
            registration.active = false
          }
        },
      },
    }

    apply(ctx as never)

    const repositoryStatus = registrations.find(entry => entry.id === 'claude-repository-status')
    const repositoryActions = repositoryStatus?.inject?.('session-1') as { openDiff(): void }
    repositoryActions.openDiff()
    const details = registrations.findLast(entry => entry.name === 'details' && entry.active)
    const detailsActions = details?.inject?.() as { toggleMaximized(): void }
    detailsActions.toggleMaximized()

    const firstOverlay = registrations.find(entry => entry.name === 'shell.overlay' && entry.active)
    expect(firstOverlay).toMatchObject({
      id: 'claude-diff-overlay',
    })
    expect(details?.active).toBe(true)
    expect(resizeLifecycle.dispose).toHaveBeenCalledOnce()
    expect(resizeLifecycle.events.slice(-2)).toEqual(['resize-dispose', 'layout-close'])
    const firstOverlayElement = firstOverlay?.component?.() as ReactElement<{ closeDetails(): void }>
    firstOverlayElement.props.closeDetails()
    expect(registrations.some(entry => entry.active && (entry.name === 'details' || entry.name === 'shell.overlay'))).toBe(false)
    expect(resizeLifecycle.dispose).toHaveBeenCalledOnce()

    repositoryActions.openDiff()
    const reopenedDetails = registrations.findLast(entry => entry.name === 'details' && entry.active)
    const reopenedActions = reopenedDetails?.inject?.() as { toggleMaximized(): void }
    reopenedActions.toggleMaximized()
    const secondOverlay = registrations.findLast(entry => entry.name === 'shell.overlay' && entry.active)
    const secondOverlayElement = secondOverlay?.component?.() as ReactElement<{ restore(): void }>
    secondOverlayElement.props.restore()

    expect(secondOverlay?.active).toBe(false)
    expect(reopenedDetails?.active).toBe(true)
    expect(resizeLifecycle.enable).toHaveBeenCalledTimes(3)
    expect(resizeLifecycle.dispose).toHaveBeenCalledTimes(2)
    expect(resizeLifecycle.events.slice(-2)).toEqual(['layout-open', 'resize-enable'])
    const restoredActions = reopenedDetails?.inject?.() as { closeDetails(): void }
    restoredActions.closeDetails()
    expect(reopenedDetails?.active).toBe(false)
    expect(resizeLifecycle.dispose).toHaveBeenCalledTimes(3)

    repositoryActions.openDiff()
    const crashDetails = registrations.findLast(entry => entry.name === 'details' && entry.active)
    const crashActions = crashDetails?.inject?.() as { toggleMaximized(): void; closeDetails(): void }
    crashActions.toggleMaximized()
    const crashedOverlay = registrations.findLast(entry => entry.name === 'shell.overlay' && entry.active)
    reportEntryError?.('shell.overlay', { options: { id: 'claude-diff-overlay' } })

    expect(crashedOverlay?.active).toBe(false)
    expect(crashDetails?.active).toBe(true)
    expect(resizeLifecycle.events.slice(-2)).toEqual(['layout-open', 'resize-enable'])
    crashActions.closeDetails()
  })
})
