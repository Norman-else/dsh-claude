import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'


function conversationCapture() {
  const definitions: Array<{ kind?: string }> = []
  const registrations: Array<{ readonly name: string; readonly key?: string }> = []
  const dispose = (): void => {}
  const uiConversation = {
    events: {
      register(definition: { kind?: string }) {
        definitions.push(definition)
        return dispose
      },
    },
  }
  const ctx = {
    effect(register: () => unknown) { register() },
    get(name: string) { return name === 'uiConversation' ? uiConversation : undefined },
    inject() { throw new Error('legacy conversationEvents injection must not be used') },
    locale: { register: () => dispose, bind: () => (key: string) => key },
    inputTriggers: { registerSource: () => dispose },
    sidebarRightTabs: { register: () => dispose },
    sidebarRight: { openTabIn: () => {}, closeIn: () => {}, toggleExpanded: () => {} },
    slots: {
      onEntryError: () => dispose,
      inject(_name: string, register: () => unknown) { register() },
      register(options: { readonly name: string; readonly key?: string }) {
        registrations.push(options)
        return dispose
      },
    },
  }
  return { ctx, definitions, registrations }
}

describe('Claude client slot registration', () => {
  it('registers the transcript node unconditionally so the renderer choice is read per step', () => {
    // Registration must not depend on a Client-side copy of the setting: the
    // Host switches on the next turn, and a boot-time decision that disagreed
    // would draw every step twice. A natively drawn step folds to no items.
    const captured = conversationCapture()
    apply(captured.ctx as never)

    expect(captured.definitions.map(definition => definition.kind)).toEqual(['claudeCode', 'claude-activity-step', 'claude-active-tasks'])
    expect(captured.registrations.some(entry => entry.key === 'claude-activity-step')).toBe(true)
    expect(captured.registrations.some(entry => entry.name === 'conversation.chat.turnTail')).toBe(true)
  })

  it('mounts the custom Claude definitions through the Desktop conversation service', () => {
    const definitions: unknown[] = []
    const dispose = (): void => {}
    const uiConversation = {
      events: {
        register(definition: unknown) {
          definitions.push(definition)
          return dispose
        },
      },
    }
    const ctx = {
      effect(register: () => unknown) {
        register()
      },
      get(name: string) {
        return name === 'uiConversation' ? uiConversation : undefined
      },
      inject() {
        throw new Error('legacy conversationEvents injection must not be used')
      },
      locale: {
        register: () => dispose,
        bind: () => (key: string) => key,
      },
      inputTriggers: {
        registerSource: () => dispose,
      },
      sidebarRightTabs: { register: () => dispose },
      sidebarRight: { openTabIn: () => {}, closeIn: () => {}, toggleExpanded: () => {} },
      slots: {
        onEntryError: () => dispose,
        inject(_name: string, register: () => unknown) {
          register()
        },
        register: () => dispose,
      },
    }

    apply(ctx as never)

    expect(definitions).toHaveLength(3)
  })

  it('stacks the dock as comments, queue dock, then repository status', () => {
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
      inject(_dependencies: readonly string[], callback: (value: unknown) => void) {
        callback(ctx)
      },
      sidebarRightTabs: { register: () => dispose },
      sidebarRight: { openTabIn: () => {}, closeIn: () => {}, toggleExpanded: () => {} },
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

    const reviewComments = registrations.find(entry => entry.id === 'claude-review-comments')
    const repositoryStatus = registrations.find(entry => entry.id === 'claude-repository-status')
    expect(reviewComments).toBeDefined()
    expect(repositoryStatus).toBeDefined()
    // DSH's QueueDock owns order 20: comments sit above it, the status below.
    expect(reviewComments?.order).toBeLessThan(20)
    expect(repositoryStatus?.order).toBeGreaterThan(20)
    expect(repositoryStatus?.order).toBeLessThan(21)
  })

  it('archives a cleaned-up workspace\'s sessions before deleting it', async () => {
    const calls: string[] = []
    const registrations: Array<{ readonly id?: string; readonly inject?: (...args: unknown[]) => unknown }> = []
    const dispose = (): void => {}
    const workspaces = {
      list: {
        getSnapshot: () => ({ items: [{ workspaceId: 'workspace-1', sessionIds: ['session-1', 'session-2'] }] }),
        subscribe: () => () => {},
      },
      archiveSession: (id: string) => {
        calls.push(`archive:${id}`)
        return Promise.resolve()
      },
      delete: (id: string) => {
        calls.push(`delete:${id}`)
        return Promise.resolve()
      },
    }
    const ctx = {
      effect(register: () => unknown) {
        register()
      },
      get(name: string) {
        return name === 'workspaces' ? workspaces : undefined
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
      inject(_dependencies: readonly string[], callback: (value: unknown) => void) {
        callback(ctx)
      },
      sidebarRightTabs: { register: () => dispose },
      sidebarRight: { openTabIn: () => {}, closeIn: () => {}, toggleExpanded: () => {} },
      slots: {
        onEntryError: () => dispose,
        inject(_name: string, register: () => unknown) {
          register()
        },
        register(options: { readonly id?: string; readonly inject?: (...args: unknown[]) => unknown }) {
          registrations.push(options)
          return dispose
        },
      },
    }

    apply(ctx as never)

    const repositoryStatus = registrations.find(entry => entry.id === 'claude-repository-status')
    const actions = repositoryStatus?.inject?.('session-1') as { deleteWorkspace(): Promise<void> }
    await actions.deleteWorkspace()

    // Without the archive hop the sessions survive into the unaccounted group.
    expect(calls).toEqual(['archive:session-1', 'archive:session-2', 'delete:workspace-1'])
  })

  it('opens each panel as a right-sidebar tab and closes it through that tab', () => {
    interface Registration {
      readonly name: string
      readonly id?: string
      readonly key?: string
      readonly inject?: (...args: unknown[]) => unknown
      active: boolean
    }
    const registrations: Registration[] = []
    const definitions: { id: string; kind: string; title: () => string }[] = []
    const opened: unknown[][] = []
    const closed: unknown[][] = []
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
      sidebarRightTabs: {
        register(definition: { id: string; kind: string; title: () => string }) {
          definitions.push(definition)
          return dispose
        },
      },
      sidebarRight: {
        openTabIn: (...args: unknown[]) => { opened.push(args) },
        closeIn: (...args: unknown[]) => { closed.push(args) },
        toggleExpanded: vi.fn(),
      },
      inject(_dependencies: readonly string[], callback: (value: unknown) => void) {
        callback(ctx)
      },
      slots: {
        onEntryError: () => dispose,
        inject(_name: string, register: () => unknown) {
          register()
        },
        register(options: Omit<Registration, 'active'>) {
          const registration = { ...options, active: true }
          registrations.push(registration)
          return (): void => {
            registration.active = false
          }
        },
      },
    }

    apply(ctx as never)

    // Host 0.1.5 has no details column: every panel is a tab type declared
    // once at apply time, with its body keyed the same way.
    expect(definitions.map(definition => definition.kind).sort()).toEqual(['claude-diff', 'claude-overview', 'claude-plan', 'claude-tasks'])
    for (const definition of definitions) expect(definition.id).toBe(definition.kind)
    expect(registrations.filter(entry => entry.name === 'sidebar.right.pane.tab').map(entry => entry.key).sort())
      .toEqual(['claude-diff', 'claude-overview', 'claude-plan', 'claude-tasks'])
    expect(registrations.some(entry => entry.name === 'details')).toBe(false)

    const repositoryStatus = registrations.find(entry => entry.id === 'claude-repository-status')
    const repositoryActions = repositoryStatus?.inject?.('session-1') as { openDiff(root?: string): void }
    repositoryActions.openDiff('K:/repo')
    expect(opened.at(-1)).toEqual(['session-1', 'claude-diff', { params: { initialRoot: 'K:/repo' } }])

    // The header toggle closes the tab it opened, which it learns from the body.
    const diffBody = registrations.find(entry => entry.name === 'sidebar.right.pane.tab' && entry.key === 'claude-diff')
    const diffFace = diffBody?.inject?.('session-1') as { noteTab(tabId: string | undefined): void }
    diffFace.noteTab('tab-7')
    const diffHeader = registrations.find(entry => entry.id === 'claude-diff')
    const diffActions = diffHeader?.inject?.('session-1') as { toggleDiff(): void }
    diffActions.toggleDiff()
    expect(closed.at(-1)).toEqual(['session-1', 'tab-7'])
    diffFace.noteTab(undefined)
    diffActions.toggleDiff()
    expect(opened.at(-1)).toEqual(['session-1', 'claude-diff', { params: {} }])

    const planHeader = registrations.find(entry => entry.id === 'claude-plan')
    const planActions = planHeader?.inject?.('session-1') as { togglePlan(): void }
    planActions.togglePlan()
    expect(opened.at(-1)).toEqual(['session-1', 'claude-plan', { params: {} }])

    const tail = registrations.find(entry => entry.name === 'conversation.chat.turnTail')
    const tailActions = tail?.inject?.('session-1') as { openTasks(turn: number): void }
    tailActions.openTasks(3)
    expect(opened.at(-1)).toEqual(['session-1', 'claude-tasks', { params: { turn: 3 } }])

  })
})
