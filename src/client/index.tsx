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
import { ClaudeSelectionAsk } from './ClaudeSelectionAsk.tsx'
import { ClaudeRewind, type ClaudeChatSource, type ClaudeRewindInjected } from './ClaudeRewind.tsx'
import { ClaudeHeroRepositoryControls, type ClaudeHeroRepositoryControlsInjected } from './ClaudeHeroRepositoryControls.tsx'
import { ClaudeDiffHeaderAction, type ClaudeDiffHeaderActionInjected } from './ClaudeDiffHeaderAction.tsx'
import { ClaudeSessionMenu, type ClaudeSessionMenuInjected } from './ClaudeSessionMenu.tsx'
import { ClaudeAgentPresetLabel, type ClaudeAgentPresetLabelInjected } from './ClaudeAgentPresetLabel.tsx'
import { AgentPresetRoster, type AgentPresetRosterApi } from './agent-preset-roster.ts'
import { DiffOpenStore } from './diff-open-store.ts'
import { ClaudeProjectionStore, type ClaudeProjectionSource } from './projection.ts'
import { createClaudeCommandSource } from './claude-command-source.ts'
import { restyleHostChrome } from './host-chrome.ts'
import { enableExpandedDetailsResize } from './details-resize.ts'
import { bindRepositoryLease, loadRepositoryStatusFor, prepareRepository, type RepositoryPreparationStage } from './repository-setup-api.ts'
import { assignJiraTicket, ticketContext, ticketPrompt } from './jira-api.ts'
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
  ctx.effect(() => restyleHostChrome(), 'dsh-claude: Host chrome restyling')
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
  const diffOpen = new DiffOpenStore()
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
    diffOpen.close()
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
          ...(workspaces === undefined ? {} : { workspaces: workspaces.list as unknown as NonNullable<ClaudePullRequestsPanelInjected['workspaces']> }),
          projectionFor: id => projections.source(id),
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
    diffOpen.open(sessionId)
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
  // Icon-only diff trigger in the Session header's right-aligned utility
  // group. The action row next to the title is left-aligned (it rides inside
  // the flex:1 title cluster), so the utilities group is the actual top-right
  // corner — the seat the Host's hidden Session log capsule used to hold.
  // Shadow the Host's header preset label: same slot id, lower priority, so
  // one cell renders and it is this one. Only two things change — the native
  // `title` popup becomes the DSH tooltip bubble, and the Claude preset gets
  // its own mark instead of the generic preset glyph. Everything else is
  // reproduced, because this entry renders in every Session, not only
  // plugin-owned ones.
  if (connection !== undefined) {
    const roster = new AgentPresetRoster(connection.api.agentPresets as unknown as AgentPresetRosterApi)
    const hostT = ctx.locale.bind('settings.agentPreset')
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-preset',
      order: -10,
      priority: -10,
      locale: namespace,
      inject: (): ClaudeAgentPresetLabelInjected => ({
        t,
        hostT: key => hostT(key as never),
        roster: { subscribe: roster.subscribe, getSnapshot: roster.getSnapshot, load: () => roster.load() },
      }),
    }, ClaudeAgentPresetLabel))
  }
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'claude-diff',
    order: 30,
    locale: namespace,
    inject: (sessionId: string): ClaudeDiffHeaderActionInjected => ({
      t,
      // Toggling closes the whole details registration, so a maximized diff
      // collapses from the same press that would have collapsed the column.
      toggleDiff: () => {
        if (diffOpen.isOpen(sessionId)) closePluginDetails()
        else openDiffPanel(sessionId)
      },
      diffOpen: diffOpen.sourceFor(sessionId),
    }),
  }, ClaudeDiffHeaderAction))
  // Kebab menu at the far right of the same utility group: session-level
  // actions that are not worth a header button of their own.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'claude-session-menu',
    order: 31,
    locale: namespace,
    inject: (): ClaudeSessionMenuInjected => ({ t }),
  }, ClaudeSessionMenu))
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
  // Selection toolbar over assistant replies (copy / ask a follow-up). Root
  // scoped: it resolves the on-screen session itself and only arms inside
  // sessions this plugin owns.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'claude-selection-ask',
    locale: namespace,
  }, () => <ClaudeSelectionAsk
    t={t}
    currentSessionId={() => sessions?.list.getSnapshot().current as string | undefined}
    ownsSession={sessionId => projections.source(sessionId).getSnapshot().owned}
    {...(sessions === undefined || conversation === undefined ? {} : {
      insertIntoChat: (sessionId: string, text: string) => {
        const scope = sessions.scope(sessionId as SessionId)
        if (scope === undefined) return
        const input = conversation.input.for(scope)
        const current = input.state.getSnapshot().draft
        input.setDraft(current.trim() === '' ? text : `${current}\n\n${text}`)
      },
    })}
  />))
  // "Rewind to here" beside the copy action of every user message. Root
  // scoped like the selection toolbar: it resolves the on-screen session
  // itself and only arms inside sessions this plugin owns.
  if (sessions !== undefined) {
    // Stable prop identities: the control subscribes to them, so a re-render
    // of the seat must not tear down and rebuild every subscription.
    const rewind: ClaudeRewindInjected = {
      t,
      currentSessionId: () => sessions.list.getSnapshot().current as string | undefined,
      subscribeSessions: listener => sessions.list.subscribe(listener),
      chatOf: sessionId => sessions.binding(sessionId as SessionId)?.session as unknown as ClaudeChatSource | undefined,
      projectionOf: sessionId => projections.source(sessionId),
      ...(conversation === undefined ? {} : {
        setDraft: (sessionId: string, text: string) => {
          const scope = sessions.scope(sessionId as SessionId)
          if (scope === undefined) return
          conversation.input.for(scope).setDraft(text)
        },
      }),
    }
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'claude-rewind',
      locale: namespace,
    }, () => <ClaudeRewind {...rewind} />))
  }

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
    /** Attach a prepared worktree to its session without blocking the flow. */
    const bindLease = (leaseId: string | undefined, targetSessionId: SessionId): void => {
      if (leaseId === undefined) return
      void bindRepositoryLease(leaseId, targetSessionId).catch((reason: unknown) => {
        console.warn(`dsh-claude: could not bind the worktree lease: ${reason instanceof Error ? reason.message : String(reason)}`)
      })
    }
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
          // Starting from a ticket seeds an empty composer with the ticket
          // brief; a written draft keeps the user's words and gets the ticket
          // appended as context so the session always knows its ticket.
          const draft = ticket === undefined
            ? rawDraft
            : rawDraft.trim() === '' ? ticketPrompt(ticket) : `${rawDraft.trimEnd()}\n\n${ticketContext(ticket)}`
          const imageIds = sourceInput.state.getSnapshot().imageIds
          const prepared = await prepareRepository(cwd, branch, useWorktree, ticket?.key, onProgress)
          // The workspace is ready: take the ticket. Best-effort so a Jira
          // hiccup never blocks the session from starting.
          if (ticket !== undefined) {
            void assignJiraTicket(ticket.key).catch((reason: unknown) => {
              console.warn(`dsh-claude: could not assign ${ticket.key}: ${reason instanceof Error ? reason.message : String(reason)}`)
            })
          }
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
          // Lease bookkeeping only matters at cleanup time, so it rides
          // alongside the submit the way the ticket assignment does. Awaiting
          // it here once left the prepared worktree holding the user's typed
          // message with no way to send it when the route was slow.
          bindLease(prepared.leaseId, targetSessionId)
          sessions.open(targetSessionId)
          onProgress('submitting')
          targetInput.submit()
          sourceInput.setDraft('')
          for (const imageId of imageIds) sourceInput.removeImage(imageId)
        },
        prepareMany: async (cwd, branch, tickets, onProgress) => {
          const sourceScope = sessions.scope(sourceSessionId)
          if (sourceScope === undefined) throw new Error(t('repositorySessionUnavailable'))
          const sourceInput = conversation.input.for(sourceScope)
          // One shared draft applies to every ticket; images stay behind
          // because a single attachment cannot be split across sessions.
          const rawDraft = sourceInput.state.getSnapshot().draft
          const failures: string[] = []
          for (const [index, ticket] of tickets.entries()) {
            const report = (stage: RepositoryPreparationStage): void => {
              onProgress({ ticketKey: ticket.key, index, total: tickets.length, stage })
            }
            try {
              report('inspecting')
              const prepared = await prepareRepository(cwd, branch, true, ticket.key, report)
              void assignJiraTicket(ticket.key).catch((reason: unknown) => {
                console.warn(`dsh-claude: could not assign ${ticket.key}: ${reason instanceof Error ? reason.message : String(reason)}`)
              })
              report('creating-workspace')
              const workspace = await workspaces.create({ path: prepared.path })
              report('starting-session')
              const targetSessionId = await workspaces.connectWorkspace(workspace.workspaceId)
              const targetScope = sessions.scope(targetSessionId)
              if (targetScope === undefined) throw new Error(t('repositorySessionUnavailable'))
              const presetResponse = await connection.api.agentPresets.select({ sessionId: targetSessionId, agentPreset: 'claude' })
              if (!presetResponse.result.ok) throw new Error(presetResponse.result.error.message)
              sessions.noteAgentPreset(targetSessionId, presetResponse.result.value.agentPreset)
              const targetInput = conversation.input.for(targetScope)
              report('transferring-draft')
              targetInput.setDraft(rawDraft.trim() === '' ? ticketPrompt(ticket) : `${rawDraft.trimEnd()}\n\n${ticketContext(ticket)}`)
              bindLease(prepared.leaseId, targetSessionId)
              report('submitting')
              targetInput.submit()
            } catch (cause) {
              failures.push(`${ticket.key}: ${cause instanceof Error ? cause.message : String(cause)}`)
            }
          }
          if (failures.length < tickets.length) sourceInput.setDraft('')
          if (failures.length > 0) throw new Error(failures.join(' · '))
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
