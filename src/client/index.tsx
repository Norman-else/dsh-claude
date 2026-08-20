import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { claudeActivityStepDefinition, claudeTurnDefinition, selectClaudeTurn } from './conversation-sidecar.ts'
import { ClaudeActivityTail, type ClaudeActivityTailInjected } from './ClaudeActivityTail.tsx'
import { ClaudeActivityNode } from './ClaudeActivityNode.tsx'
import { ClaudeCodeSettings, type ClaudeCodeSettingsInjected } from './ClaudeCodeSettings.tsx'
import { ClaudeTasksHeaderButton, ClaudeTasksPanel, type ClaudeTasksLauncherInjected, type ClaudeTasksPanelInjected } from './ClaudeTasksPanel.tsx'
import { ClaudeProjectionStore } from './projection.ts'
import { en, zh, type ClaudeCodeSettingsKey } from './locales.ts'

/** The right-side details column slot declared by dsh-client-ui-layout
 *  (kind 'single', scope 'session'). Merged locally because this package does
 *  not depend on the layout package's client types. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    details: { kind: 'single'; scope: 'session' }
  }
}

interface LayoutFace {
  openDetails(): void
  closeDetails(): void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.claude-code': ClaudeCodeSettingsKey
  }
}

export const name = 'dsh-claude-code-client'
export const inject = ['slots', 'locale', 'conversationEvents', 'sessions']

export function apply(ctx: ClientContext): void {
  const namespace = 'settings.claude-code'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-claude-code: client copy')
  const t = ctx.locale.bind(namespace) as ClaudeCodeSettingsInjected['t']
  const projections = new ClaudeProjectionStore()
  const sessions = ctx.get('sessions') as ISessions | undefined
  if (sessions !== undefined) {
    ctx.effect(() => sessions.provide({
      hooks: ['claudeProjection'],
      resolve: binding => ({ hooks: { claudeProjection: projections.source(binding.sessionId) } }),
    }), 'dsh-claude-code: sidecar projection provider')
  }
  ctx.effect(() => () => projections.dispose(), 'dsh-claude-code: sidecar projection lifecycle')
  ctx.effect(() => ctx.conversationEvents.register(claudeTurnDefinition), 'dsh-claude-code: Claude turn marker')
  ctx.effect(() => ctx.conversationEvents.register(claudeActivityStepDefinition), 'dsh-claude-code: Claude activity flow node')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'claude-activity-step',
    locale: 'conversation',
  }, ClaudeActivityNode))
  const layout = ctx.get('layout') as LayoutFace | undefined
  // Conditional switching for the details column: the tasks panel registration
  // exists only while the panel is open. While closed, the built-in tool
  // details view (priority 0) owns the single slot again.
  const tasksPanelListeners = new Set<() => void>()
  let disposeTasksDetails: (() => void) | undefined
  let tasksPanelSession: string | undefined
  const notifyTasksPanel = (): void => {
    for (const fn of [...tasksPanelListeners]) fn()
  }
  const closeTasksPanel = (): void => {
    if (disposeTasksDetails === undefined) return
    disposeTasksDetails()
    disposeTasksDetails = undefined
    tasksPanelSession = undefined
    layout?.closeDetails()
    notifyTasksPanel()
  }
  const openTasksPanel = (sessionId: string): void => {
    closeTasksPanel()
    // The details column is a single slot and the built-in conversation UI
    // already occupies priority 0, so register below it (lowest renders) to
    // shadow it until the panel closes.
    try {
      disposeTasksDetails = ctx.slots.register({
        name: 'details',
        priority: -10,
        locale: namespace,
        inject: (): ClaudeTasksPanelInjected => ({
          t,
          closeDetails: closeTasksPanel,
        }),
      }, ClaudeTasksPanel)
    } catch {
      return
    }
    tasksPanelSession = sessionId
    layout?.openDetails()
    notifyTasksPanel()
  }
  const toggleTasksPanel = (sessionId: string): void => {
    if (tasksPanelSession === sessionId) closeTasksPanel()
    else openTasksPanel(sessionId)
  }
  ctx.effect(() => () => closeTasksPanel(), 'dsh-claude-code: tasks panel lifecycle')
  const tasksLauncher = (sessionId: string): Omit<ClaudeTasksLauncherInjected, 't'> => ({
    isOpen: () => tasksPanelSession === sessionId,
    toggle: () => toggleTasksPanel(sessionId),
    subscribe: (fn) => {
      tasksPanelListeners.add(fn)
      return () => {
        tasksPanelListeners.delete(fn)
      }
    },
  })
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    select: selectClaudeTurn,
    inject: (sessionId: string): ClaudeActivityTailInjected => ({
      t,
      openTasks: () => openTasksPanel(sessionId),
    }),
  }, ClaudeActivityTail))
  if (sessions !== undefined) {
    // The layout closes the column on session switch; mirror that here so the
    // next session's native details view is not shadowed.
    ctx.effect(() => sessions.list.subscribe(() => {
      if (tasksPanelSession !== undefined && sessions.list.getSnapshot().current !== tasksPanelSession) closeTasksPanel()
    }), 'dsh-claude-code: tasks panel session tracking')
  }
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'claude-tasks',
    order: -10,
    label: () => t('tasksOpen'),
    inject: (sessionId: string): ClaudeTasksLauncherInjected => ({
      t,
      ...tasksLauncher(sessionId),
    }),
  }, ClaudeTasksHeaderButton))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'claude-code',
    order: 16,
    label: () => t('nav'),
    inject: (): ClaudeCodeSettingsInjected => ({ t }),
  }, ClaudeCodeSettings))
}
