import { useSyncExternalStore } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext, ISessions, IWorkspaces, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
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
import { ClaudeReviewComments, type ClaudeReviewCommentsInjected } from './ClaudeReviewComments.tsx'
import { ClaudeDiffPanel, type ClaudeDiffPanelInjected } from './ClaudeDiffPanel.tsx'
import { ClaudeDiffOverlay } from './ClaudeDiffOverlay.tsx'
import { ClaudeQueueDock, type ClaudeQueueDockInjected } from './ClaudeQueueDock.tsx'
import { ClaudePullRequestsPanel, type ClaudePullRequestsPanelInjected } from './ClaudePullRequestsPanel.tsx'
import { ClaudeHeroRepositoryControls, type ClaudeHeroRepositoryControlsInjected } from './ClaudeHeroRepositoryControls.tsx'
import { ClaudeProjectionStore, type ClaudeProjectionSource } from './projection.ts'
import { createClaudeCommandSource } from './claude-command-source.ts'
import { enableExpandedDetailsResize } from './details-resize.ts'
import { bindRepositoryLease, loadRepositoryStatusFor, prepareRepository } from './repository-setup-api.ts'
import { ticketPrompt } from './jira-api.ts'
import { en, zh, type ClaudeCodeSettingsKey } from './locales.ts'

/** The right-side details column slot declared by dsh-client-ui-layout
 *  (kind 'single', scope 'session'). Merged locally because this package does
 *  not depend on the layout package's client types. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    details: { kind: 'single'; scope: 'session' }
    'shell.overlay': { kind: 'list'; scope: 'root' }
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

function MaximizedDiff({
  source, t, sessionId, closeDetails, restore, submitPrompt,
}: {
  source: ClaudeProjectionSource
  t: ClaudeDiffPanelInjected['t']
  sessionId: string
  closeDetails: () => void
  restore: () => void
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const useClaudeProjection = <S,>(selector: (value: typeof snapshot) => S): S => selector(snapshot)
  return <ClaudeDiffOverlay onRestore={restore}><ClaudeDiffPanel
    useClaudeProjection={useClaudeProjection}
    t={t}
    sessionId={sessionId}
    maximized
    closeDetails={closeDetails}
    toggleMaximized={restore}
    {...(submitPrompt === undefined ? {} : { submitPrompt })}
  /></ClaudeDiffOverlay>
}

export const name = 'dsh-claude-client'
export const inject = ['slots', 'locale', 'conversationEvents', 'sessions', 'workspaces', 'inputTriggers', 'conversation', 'connection']

export function apply(ctx: ClientContext): void {
  const namespace = 'settings.claude-code'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-claude: client copy')
  const t = ctx.locale.bind(namespace) as ClaudeCodeSettingsInjected['t']
  const projections = new ClaudeProjectionStore()
  ctx.effect(() => ctx.inputTriggers.registerSource(createClaudeCommandSource(ctx, projections)), 'dsh-claude: Claude slash source')
  const sessions = ctx.get('sessions') as ISessions | undefined
  const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
  const conversation = ctx.get('conversation') as IConversation | undefined
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  /** Composer submit hook shared by the repository feedback affordances.
   *  'append' keeps any user draft and adds the prompt below it; 'idle'
   *  submits only when the composer is empty and reports false otherwise. */
  const submitPromptFor = (sessionId: string): ((draft: string, mode?: 'append' | 'idle') => boolean) | undefined => {
    if (sessions === undefined || conversation === undefined) return undefined
    return (draft, mode = 'append') => {
      const scope = sessions.scope(sessionId as SessionId)
      if (scope === undefined) return false
      const input = conversation.input.for(scope)
      const current = input.state.getSnapshot().draft
      if (current.trim() === '') input.setDraft(draft)
      else if (mode === 'append') input.setDraft(`${current}\n\n${draft}`)
      else return false
      input.submit()
      return true
    }
  }
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
  // Keep the plugin details registration mounted while its maximized overlay is
  // visible so its session-bound state survives the round trip.
  let disposePluginDetails: (() => void) | undefined
  let disposeDiffOverlay: (() => void) | undefined
  let disposeExpandedDetailsResize: (() => void) | undefined
  let detailsSessionId: string | undefined
  const restoreDiff = (): void => {
    if (disposeDiffOverlay === undefined) return
    disposeDiffOverlay()
    disposeDiffOverlay = undefined
    layout?.openDetails()
    disposeExpandedDetailsResize = enableExpandedDetailsResize()
  }
  const closePluginDetails = (): void => {
    if (disposePluginDetails === undefined && disposeDiffOverlay === undefined && disposeExpandedDetailsResize === undefined && detailsSessionId === undefined) return
    disposeDiffOverlay?.()
    disposeDiffOverlay = undefined
    disposeExpandedDetailsResize?.()
    disposeExpandedDetailsResize = undefined
    disposePluginDetails?.()
    disposePluginDetails = undefined
    detailsSessionId = undefined
    layout?.closeDetails()
  }
  ctx.effect(() => ctx.slots.onEntryError((key, entry) => {
    if (key === 'shell.overlay' && entry.options.id === 'claude-diff-overlay') restoreDiff()
  }), 'dsh-claude: diff overlay recovery')
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
  const openOverviewPanel = (sessionId: string): void => {
    if (sessions === undefined) return
    closePluginDetails()
    try {
      disposePluginDetails = ctx.slots.register({
        name: 'details',
        priority: -10,
        locale: namespace,
        inject: (): ClaudePullRequestsPanelInjected => ({
          t,
          closeDetails: closePluginDetails,
          openSession: id => { sessions.open(id as SessionId) },
          loadStatus: loadRepositoryStatusFor,
          sessions: sessions.list as unknown as ClaudePullRequestsPanelInjected['sessions'],
        }),
      }, ClaudePullRequestsPanel)
    } catch {
      return
    }
    detailsSessionId = sessionId
    layout?.openDetails()
    disposeExpandedDetailsResize = enableExpandedDetailsResize()
  }
  const openDiffPanel = (sessionId: string): void => {
    closePluginDetails()
    detailsSessionId = sessionId
    const submitPrompt = submitPromptFor(sessionId)
    const registerDetails = (): boolean => {
      try {
        disposePluginDetails = ctx.slots.register({
          name: 'details',
          priority: -10,
          locale: namespace,
          inject: (): ClaudeDiffPanelInjected => ({
            t,
            sessionId,
            maximized: false,
            closeDetails: closePluginDetails,
            toggleMaximized: maximizeDiff,
            ...(submitPrompt === undefined ? {} : { submitPrompt }),
          }),
        }, ClaudeDiffPanel)
      } catch {
        disposePluginDetails = undefined
        return false
      }
      layout?.openDetails()
      return true
    }
    const maximizeDiff = (): void => {
      if (disposeDiffOverlay !== undefined) {
        restoreDiff()
        return
      }
      disposeExpandedDetailsResize?.()
      disposeExpandedDetailsResize = undefined
      layout?.closeDetails()
      try {
        disposeDiffOverlay = ctx.slots.register({
          name: 'shell.overlay',
          id: 'claude-diff-overlay',
          locale: namespace,
        }, () => <MaximizedDiff
          source={projections.source(sessionId)}
          t={t}
          sessionId={sessionId}
          closeDetails={closePluginDetails}
          restore={restoreDiff}
          {...(submitPrompt === undefined ? {} : { submitPrompt })}
        />)
      } catch {
        disposeDiffOverlay = undefined
        layout?.openDetails()
        disposeExpandedDetailsResize = enableExpandedDetailsResize()
      }
    }
    if (!registerDetails()) {
      detailsSessionId = undefined
      return
    }
    disposeExpandedDetailsResize = enableExpandedDetailsResize()
  }
  ctx.effect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => closePluginDetails()
    const observer = new MutationObserver(() => {
      if (detailsSessionId !== undefined && disposeDiffOverlay === undefined && document.querySelector('[data-details-collapsed]') !== null) {
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
    id: 'claude-review-comments',
    // Topmost dock row: pending comments render above DSH's QueueDock (20)
    // and the repository status readout (20.5).
    order: 18,
    locale: namespace,
    inject: (sessionId: string): ClaudeReviewCommentsInjected => ({
      t,
      sessionId,
      ...(sessions === undefined || conversation === undefined ? {} : {
        submitWith: (fallbackDraft: string) => {
          const scope = sessions.scope(sessionId as SessionId)
          if (scope === undefined) return
          const input = conversation.input.for(scope)
          if (input.state.getSnapshot().draft.trim() === '') input.setDraft(fallbackDraft)
          input.submit()
        },
      }),
    }),
  }, ClaudeReviewComments))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'claude-repository-status',
    // Below DSH's QueueDock (20) and above the hero controls (21), so the
    // dock stacks comments (18) → queue (20) → repository readout.
    order: 20.5,
    locale: namespace,
    inject: (sessionId: string): ClaudeRepositoryStatusInjected => {
      const submitPrompt = submitPromptFor(sessionId)
      return {
        t,
        openDiff: () => openDiffPanel(sessionId),
        ...(submitPrompt === undefined ? {} : { submitPrompt }),
        ...(sessions === undefined ? {} : { openOverview: () => openOverviewPanel(sessionId) }),
        ...(workspaces === undefined ? {} : {
          deleteWorkspace: async () => {
            const workspace = workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId as SessionId))
            if (workspace !== undefined) await workspaces.delete(workspace.workspaceId)
          },
        }),
      }
    },
  }, ClaudeRepositoryStatus))
  if (sessions !== undefined && conversation !== undefined) {
    // Shadow the Host queue strip: list-slot entries sharing an id form one
    // cell and the lowest priority renders, so this replaces it app-wide with
    // a strip that matches the repository status bar.
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'queue',
      order: 20,
      priority: -10,
      locale: namespace,
      inject: (sessionId: string): ClaudeQueueDockInjected => {
        const scope = sessions.scope(sessionId as SessionId)
        const scoped = scope === undefined ? undefined : (scope as unknown as { get(name: string): unknown }).get('conversation') as IConversation | undefined
        const target = scoped ?? conversation
        return {
          t,
          updateQueue: (itemId, action) => target.updateQueue(itemId as never, action as never),
          notify: (level, text) => { if (scope !== undefined) conversation.input.for(scope).notify(level, text) },
        }
      },
    }, ClaudeQueueDock))
  }
  if (sessions !== undefined && workspaces !== undefined && conversation !== undefined && connection !== undefined) {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'claude-hero-repository-controls',
      order: 21,
      locale: namespace,
      inject: (sourceSessionId: SessionId): ClaudeHeroRepositoryControlsInjected => ({
        t,
        prepare: async (cwd, branch, useWorktree, onProgress, ticket) => {
          const sourceScope = sessions.scope(sourceSessionId)
          if (sourceScope === undefined) throw new Error(t('repositorySessionUnavailable'))
          const sourceInput = conversation.input.for(sourceScope)
          const rawDraft = sourceInput.state.getSnapshot().draft
          // Starting from a ticket seeds an empty composer with the ticket brief
          // and names the branch exactly after the ticket key.
          const draft = rawDraft.trim() === '' && ticket !== undefined ? ticketPrompt(ticket) : rawDraft
          const imageIds = sourceInput.state.getSnapshot().imageIds
          const prepared = await prepareRepository(cwd, branch, useWorktree, ticket?.key, onProgress)
          if (prepared.mode === 'checkout') {
            if (draft !== rawDraft) sourceInput.setDraft(draft)
            sourceInput.submit()
            return
          }
          onProgress('creating-workspace')
          const workspace = await workspaces.create({ path: prepared.path })
          onProgress('starting-session')
          const targetSessionId = await workspaces.connectWorkspace(workspace.workspaceId)
          const targetScope = sessions.scope(targetSessionId)
          if (targetScope === undefined) throw new Error(t('repositorySessionUnavailable'))
          const presetResponse = await connection.api.agentPresets.select({ sessionId: targetSessionId, agentPreset: 'claude' })
          if (!presetResponse.result.ok) throw new Error(presetResponse.result.error.message)
          sessions.noteAgentPreset(targetSessionId, presetResponse.result.value.agentPreset)
          const targetInput = conversation.input.for(targetScope)
          onProgress('transferring-draft')
          if (imageIds.length > 0 && !targetInput.addImages(imageIds)) throw new Error(t('repositoryDraftTransferFailed'))
          if (draft !== '') targetInput.setDraft(draft)
          if (prepared.leaseId !== undefined) await bindRepositoryLease(prepared.leaseId, targetSessionId)
          sessions.open(targetSessionId)
          onProgress('submitting')
          targetInput.submit()
          sourceInput.setDraft('')
          for (const imageId of imageIds) sourceInput.removeImage(imageId)
        },
      }),
    }, ClaudeHeroRepositoryControls))
  }
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
