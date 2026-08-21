import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { claudeActiveTasksDefinition, claudeActivityStepDefinition, claudeTurnDefinition, selectClaudeTurn } from './conversation-sidecar.ts'
import { ClaudeActivityTail, type ClaudeActivityTailInjected } from './ClaudeActivityTail.tsx'
import { ClaudeActiveTasksNode } from './ClaudeActiveTasksNode.tsx'
import { ClaudeActivityNode } from './ClaudeActivityNode.tsx'
import { ClaudeCodeSettings, type ClaudeCodeSettingsInjected } from './ClaudeCodeSettings.tsx'
import { ClaudeTasksPanel, type ClaudeTasksPanelInjected } from './ClaudeTasksPanel.tsx'
import { ClaudeRepositoryStatus, type ClaudeRepositoryStatusInjected } from './ClaudeRepositoryStatus.tsx'
import { ClaudeDiffPanel, type ClaudeDiffPanelInjected } from './ClaudeDiffPanel.tsx'
import { ClaudeProjectionStore } from './projection.ts'
import { createClaudeCommandSource } from './claude-command-source.ts'
import { enableExpandedDetailsResize } from './details-resize.ts'
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

export const name = 'dsh-claude-client'
export const inject = ['slots', 'locale', 'conversationEvents', 'sessions', 'inputTriggers', 'conversation']

export function apply(ctx: ClientContext): void {
  const namespace = 'settings.claude-code'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-claude: client copy')
  const t = ctx.locale.bind(namespace) as ClaudeCodeSettingsInjected['t']
  const projections = new ClaudeProjectionStore()
  ctx.effect(() => ctx.inputTriggers.registerSource(createClaudeCommandSource(ctx, projections)), 'dsh-claude: Claude slash source')
  const sessions = ctx.get('sessions') as ISessions | undefined
  if (sessions !== undefined) {
    ctx.effect(() => sessions.provide({
      hooks: ['claudeProjection'],
      resolve: binding => ({ hooks: { claudeProjection: projections.source(binding.sessionId) } }),
    }), 'dsh-claude: sidecar projection provider')
  }
  ctx.effect(() => () => projections.dispose(), 'dsh-claude: sidecar projection lifecycle')
  ctx.effect(() => ctx.conversationEvents.register(claudeTurnDefinition), 'dsh-claude: Claude turn marker')
  ctx.effect(() => ctx.conversationEvents.register(claudeActivityStepDefinition), 'dsh-claude: Claude activity flow node')
  ctx.effect(() => ctx.conversationEvents.register(claudeActiveTasksDefinition), 'dsh-claude: active Claude tasks node')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'claude-activity-step',
    locale: namespace,
  }, ClaudeActivityNode))
  const layout = ctx.get('layout') as LayoutFace | undefined
  // Only one plugin-owned details surface exists at a time. While closed, the
  // built-in tool details view (priority 0) owns the single slot again.
  let disposePluginDetails: (() => void) | undefined
  let disposeExpandedDetailsResize: (() => void) | undefined
  let detailsSessionId: string | undefined
  const closePluginDetails = (): void => {
    if (disposePluginDetails === undefined) return
    disposeExpandedDetailsResize?.()
    disposeExpandedDetailsResize = undefined
    disposePluginDetails()
    disposePluginDetails = undefined
    detailsSessionId = undefined
    layout?.closeDetails()
  }
  const openTasksPanel = (sessionId: string, turn: number): void => {
    closePluginDetails()
    try {
      disposePluginDetails = ctx.slots.register({
        name: 'details',
        priority: -10,
        locale: namespace,
        inject: (): ClaudeTasksPanelInjected => ({ t, turn, closeDetails: closePluginDetails }),
      }, ClaudeTasksPanel)
    } catch {
      return
    }
    detailsSessionId = sessionId
    layout?.openDetails()
    disposeExpandedDetailsResize = enableExpandedDetailsResize()
  }
  const openDiffPanel = (sessionId: string): void => {
    closePluginDetails()
    try {
      disposePluginDetails = ctx.slots.register({
        name: 'details',
        priority: -10,
        locale: namespace,
        inject: (): ClaudeDiffPanelInjected => ({ t, closeDetails: closePluginDetails }),
      }, ClaudeDiffPanel)
    } catch {
      return
    }
    detailsSessionId = sessionId
    layout?.openDetails()
    disposeExpandedDetailsResize = enableExpandedDetailsResize()
  }
  ctx.effect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => closePluginDetails()
    const observer = new MutationObserver(() => {
      if (detailsSessionId !== undefined && document.querySelector('[data-details-collapsed]') !== null) {
        closePluginDetails()
      }
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-details-collapsed'], subtree: true })
    return () => {
      observer.disconnect()
      closePluginDetails()
    }
  }, 'dsh-claude: details panel lifecycle')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'claude-active-tasks',
    locale: namespace,
    inject: (sessionId: string) => ({
      openTasks: (turn: number) => openTasksPanel(sessionId, turn),
    }),
  }, ClaudeActiveTasksNode))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    select: selectClaudeTurn,
    inject: (sessionId: string): ClaudeActivityTailInjected => ({
      t,
      openTasks: turn => openTasksPanel(sessionId, turn),
    }),
  }, ClaudeActivityTail))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'claude-repository-status',
    order: 20,
    locale: namespace,
    inject: (sessionId: string): ClaudeRepositoryStatusInjected => ({
      t,
      openDiff: () => openDiffPanel(sessionId),
    }),
  }, ClaudeRepositoryStatus))
  if (sessions !== undefined) {
    // The layout closes the column on session switch; mirror that here so the
    // next session's native details view is not shadowed.
    ctx.effect(() => sessions.list.subscribe(() => {
      if (detailsSessionId !== undefined && sessions.list.getSnapshot().current !== detailsSessionId) closePluginDetails()
    }), 'dsh-claude: details panel session tracking')
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'claude-code',
    order: 16,
    label: () => t('nav'),
    inject: (): ClaudeCodeSettingsInjected => ({ t }),
  }, ClaudeCodeSettings))
}
