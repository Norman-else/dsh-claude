import { useCallback, useEffect } from 'react'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ClaudeDiffPanel, type ClaudeDiffPanelInjected, type ClaudeDiffPanelProps } from './ClaudeDiffPanel.tsx'
import { ClaudePlanPanel, type ClaudePlanPanelInjected, type ClaudePlanPanelProps } from './ClaudePlanPanel.tsx'
import { ClaudeTasksPanel, type ClaudeTasksPanelInjected, type ClaudeTasksPanelProps } from './ClaudeTasksPanel.tsx'
import { ClaudePullRequestsPanel, type ClaudePullRequestsPanelInjected } from './ClaudePullRequestsPanel.tsx'
import type { ClaudeCodeSettingsKey } from './locales.ts'

/**
 * The plugin's panels as tabs of the Host's right sidebar.
 *
 * Host 0.1.5 removed the `details` column this package used to register a
 * single panel into, and replaced it with a tabbed, splittable, floatable right
 * sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`). A panel there is a
 * tab *type*: declared once in `ctx.sidebarRightTabs`, with its body registered
 * into `sidebar.right.pane.tab` under the type's id, and opened per session
 * through `ctx.sidebarRight.openTabIn`. Reopening a type that is already open
 * focuses that tab and re-delivers the navigation params, so a second "show
 * tasks" press for another turn lands in the same tab.
 *
 * The Host owns fullscreen and closing now: the sidebar chrome carries its
 * own fullscreen toggle, so the panels draw none, and a panel's close button
 * closes its tab.
 */

export const CLAUDE_TAB_KINDS = {
  diff: 'claude-diff',
  plan: 'claude-plan',
  tasks: 'claude-tasks',
  overview: 'claude-overview',
} as const

export type ClaudeTabKind = (typeof CLAUDE_TAB_KINDS)[keyof typeof CLAUDE_TAB_KINDS]

export interface ClaudeTabParams {
  readonly turn?: number
  readonly initialRoot?: string
}

/** What every tab body is handed beside the Host's standard props. */
export interface ClaudeTabFace {
  /** Report the tab this body occupies, and `undefined` when it unmounts;
   *  this is how the header toggles learn what to close. */
  noteTab(tabId: string | undefined): void
}

/** The tab-open state one header toggle observes for one session. */
export interface ClaudeTabOpenSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
}

export interface ClaudeSidebarTabs {
  open(kind: ClaudeTabKind, sessionId: string, params: ClaudeTabParams): void
  close(kind: ClaudeTabKind, sessionId: string): void
  toggle(kind: ClaudeTabKind, sessionId: string, params: ClaudeTabParams): void
  isOpen(kind: ClaudeTabKind, sessionId: string): boolean
  sourceFor(kind: ClaudeTabKind, sessionId: string): ClaudeTabOpenSource
}

type Translate = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string

export interface ClaudeSidebarTabOptions {
  t: Translate
  namespace: 'settings.claude-code'
  /** Per-session extras for the diff body; the rest comes from the tab. */
  diffFace: (sessionId: string) => Pick<ClaudeDiffPanelInjected, 'submitPrompt'>
  /** Per-session extras for the overview body, or nothing when the session
   *  list is not available and the body should stay empty. */
  overviewFace: (sessionId: string) => Omit<ClaudePullRequestsPanelInjected, 'closeDetails'> | undefined
}

/** Which tab (if any) each kind currently occupies, per session. */
class TabOccupancy {
  readonly #byKey = new Map<string, string>()
  readonly #listeners = new Map<string, Set<() => void>>()

  static key(kind: ClaudeTabKind, sessionId: string): string {
    // A separator no kind or session id can contain, written as an escape so
    // the source stays text: a literal NUL here made git treat the file as binary.
    return `${kind}\0${sessionId}`
  }

  tabId(kind: ClaudeTabKind, sessionId: string): string | undefined {
    return this.#byKey.get(TabOccupancy.key(kind, sessionId))
  }

  note(kind: ClaudeTabKind, sessionId: string, tabId: string | undefined): void {
    const key = TabOccupancy.key(kind, sessionId)
    const previous = this.#byKey.get(key)
    if (tabId === undefined) this.#byKey.delete(key)
    else this.#byKey.set(key, tabId)
    if (previous === tabId) return
    for (const listener of this.#listeners.get(key) ?? []) listener()
  }

  source(kind: ClaudeTabKind, sessionId: string): ClaudeTabOpenSource {
    const key = TabOccupancy.key(kind, sessionId)
    return {
      subscribe: listener => {
        let set = this.#listeners.get(key)
        if (set === undefined) {
          set = new Set()
          this.#listeners.set(key, set)
        }
        set.add(listener)
        return () => { set.delete(listener) }
      },
      getSnapshot: () => this.#byKey.has(key),
    }
  }
}

/** Bind a panel body to the tab it lives in: report occupancy, and map the
 *  tab surface onto the panel's close / maximize props. */
function useClaudeTab(useTabInfo: UseSidebarRightTabInfo, noteTab: ClaudeTabFace['noteTab']) {
  const info = useTabInfo()
  const tabId = info.tab.id
  useEffect(() => {
    noteTab(tabId)
    return () => { noteTab(undefined) }
  }, [noteTab, tabId])
  const actions = info.tab.actions
  const closeDetails = useCallback(() => { actions.close() }, [actions])
  return {
    closeDetails,
    params: (info.tab.navigation.params ?? {}) as ClaudeTabParams,
  }
}

type TabBodyProps<P> = Omit<P, 'closeDetails'> & ClaudeTabFace & {
  useTabInfo: UseSidebarRightTabInfo
}

export function ClaudeDiffTab({ useTabInfo, noteTab, ...panel }: TabBodyProps<ClaudeDiffPanelProps>) {
  const { closeDetails, params } = useClaudeTab(useTabInfo, noteTab)
  return <ClaudeDiffPanel
    {...panel}
    closeDetails={closeDetails}
    {...(params.initialRoot === undefined ? {} : { initialRoot: params.initialRoot })}
  />
}

export function ClaudePlanTab({ useTabInfo, noteTab, ...panel }: TabBodyProps<ClaudePlanPanelProps>) {
  const { closeDetails } = useClaudeTab(useTabInfo, noteTab)
  return <ClaudePlanPanel {...panel} closeDetails={closeDetails} />
}

export function ClaudeTasksTab({ useTabInfo, noteTab, ...panel }: TabBodyProps<Omit<ClaudeTasksPanelProps, 'turn'>>) {
  const { closeDetails, params } = useClaudeTab(useTabInfo, noteTab)
  return <ClaudeTasksPanel {...panel} closeDetails={closeDetails} turn={params.turn ?? 0} />
}

export function ClaudeOverviewTab({ useTabInfo, noteTab, face }: ClaudeTabFace & {
  useTabInfo: UseSidebarRightTabInfo
  face: Omit<ClaudePullRequestsPanelInjected, 'closeDetails'> | undefined
}) {
  const { closeDetails } = useClaudeTab(useTabInfo, noteTab)
  if (face === undefined) return null
  return <ClaudePullRequestsPanel {...face} closeDetails={closeDetails} />
}

/** Declare the four tab types and their bodies; returns the per-session
 *  open / close / toggle face the rest of the client drives them through. */
export function registerClaudeSidebarTabs(ctx: ClientContext, options: ClaudeSidebarTabOptions): ClaudeSidebarTabs {
  const { t, namespace } = options
  const occupancy = new TabOccupancy()
  const faceFor = (kind: ClaudeTabKind, sessionId: string): ClaudeTabFace => ({
    noteTab: tabId => { occupancy.note(kind, sessionId, tabId) },
  })

  const titles: Record<ClaudeTabKind, () => string> = {
    [CLAUDE_TAB_KINDS.diff]: () => t('diffTabTitle'),
    [CLAUDE_TAB_KINDS.plan]: () => t('planPanelTitle'),
    [CLAUDE_TAB_KINDS.tasks]: () => t('tasksPanel'),
    [CLAUDE_TAB_KINDS.overview]: () => t('overviewTitle'),
  }
  for (const kind of Object.values(CLAUDE_TAB_KINDS)) {
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: kind,
      kind,
      priority: 'extension',
      title: titles[kind],
    }), `dsh-claude: ${kind} tab type`)
  }

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CLAUDE_TAB_KINDS.diff,
    locale: namespace,
    inject: (sessionId: string) => ({ t, sessionId, ...faceFor(CLAUDE_TAB_KINDS.diff, sessionId), ...options.diffFace(sessionId) }),
  }, ClaudeDiffTab))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CLAUDE_TAB_KINDS.plan,
    locale: namespace,
    inject: (sessionId: string): Omit<ClaudePlanPanelInjected, 'closeDetails'> & ClaudeTabFace => (
      { t, sessionId, ...faceFor(CLAUDE_TAB_KINDS.plan, sessionId) }
    ),
  }, ClaudePlanTab))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CLAUDE_TAB_KINDS.tasks,
    locale: namespace,
    inject: (sessionId: string): Omit<ClaudeTasksPanelInjected, 'closeDetails' | 'turn'> & ClaudeTabFace => (
      { t, ...faceFor(CLAUDE_TAB_KINDS.tasks, sessionId) }
    ),
  }, ClaudeTasksTab))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CLAUDE_TAB_KINDS.overview,
    locale: namespace,
    inject: (sessionId: string) => ({ ...faceFor(CLAUDE_TAB_KINDS.overview, sessionId), face: options.overviewFace(sessionId) }),
  }, ClaudeOverviewTab))

  const open = (kind: ClaudeTabKind, sessionId: string, params: ClaudeTabParams): void => {
    ctx.sidebarRight.openTabIn(sessionId as SessionId, kind, { params: params as never })
  }
  const close = (kind: ClaudeTabKind, sessionId: string): void => {
    const tabId = occupancy.tabId(kind, sessionId)
    if (tabId !== undefined) ctx.sidebarRight.closeIn(sessionId as SessionId, tabId as never)
  }
  return {
    open,
    close,
    toggle: (kind, sessionId, params) => {
      if (occupancy.tabId(kind, sessionId) === undefined) open(kind, sessionId, params)
      else close(kind, sessionId)
    },
    isOpen: (kind, sessionId) => occupancy.tabId(kind, sessionId) !== undefined,
    sourceFor: (kind, sessionId) => occupancy.source(kind, sessionId),
  }
}
