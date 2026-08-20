import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ChatConversationViewNode,
  ConversationNodeAssembler as ConversationNodeAssemblerType,
  ConversationNodeDefinition,
  ConversationTimelineSnapshot,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ClaudeActivityEvent } from '../src/events.ts'
import {
  activityRowsForStep,
  activityRowsForTurn,
  claudeActivityStepDefinition,
  claudeTurnDefinition,
  selectClaudeTurn,
} from '../src/client/conversation-sidecar.ts'
import {
  activitiesForTask,
  ClaudeTasksHeaderButton,
  runningTasksForTurn,
  visibleTaskGroups,
} from '../src/client/ClaudeTasksPanel.tsx'

const taskCall: ClaudeActivityEvent = {
  turn: 2, step: 1, ordinal: 1, kind: 'tool-call', phase: 'started',
  toolUseId: 'task-1', toolName: 'Task', title: 'Task', summary: 'Explore module',
}
const nestedStarted: ClaudeActivityEvent = {
  turn: 2, step: 1, ordinal: 2, kind: 'subagent', phase: 'started',
  toolUseId: 'sub-1', parentToolUseId: 'task-1', toolName: 'Read', summary: 'Reading',
}
const nestedDone: ClaudeActivityEvent = { ...nestedStarted, ordinal: 3, phase: 'completed' }
const taskDone: ClaudeActivityEvent = {
  turn: 2, step: 1, ordinal: 4, kind: 'tool-result', phase: 'completed',
  toolUseId: 'task-1', title: 'Tool completed',
}

let loadedConversationNodeAssembler: typeof ConversationNodeAssemblerType | undefined

async function loadConversationNodeAssembler(): Promise<typeof ConversationNodeAssemblerType> {
  if (loadedConversationNodeAssembler !== undefined) return loadedConversationNodeAssembler
  let clientExports: { ConversationNodeAssembler?: typeof ConversationNodeAssemblerType } | undefined
  class EmptyService {}
  class EmptyContext {}
  class EmptySlotCore {}
  const dependencies: Record<string, unknown> = {
    '@deepseek-ai/cordis': { Service: EmptyService, Context: EmptyContext },
    '@deepseek-ai/dsh-client-ui-slots': { SlotCore: EmptySlotCore },
  }
  Object.assign(globalThis, {
    window: {
      __ModuleLoader__: {
        load(definition: { factory(require: (id: string) => unknown): unknown }) {
          clientExports = definition.factory(id => dependencies[id]) as typeof clientExports
        },
      },
    },
  })
  await import('@deepseek-ai/dsh-client-runtime/client')
  if (clientExports?.ConversationNodeAssembler === undefined) throw new Error('Client runtime did not export ConversationNodeAssembler')
  loadedConversationNodeAssembler = clientExports.ConversationNodeAssembler
  return loadedConversationNodeAssembler
}

const assistantTestDefinition: ConversationNodeDefinition<{ readonly seq: number; readonly turn: number; readonly step: number }> = {
  kind: 'test-assistant',
  target: 'chat',
  match(event) {
    if (event.type !== 'assistant/message') return null
    return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
  },
  start(_context, match) {
    if (match.event.type !== 'assistant/message') throw new Error('Test assistant requires assistant/message')
    return { seq: match.event.seq, turn: match.event.data.turn, step: match.event.data.step }
  },
  update(context) {
    return context.state
  },
  buildViewNode(context): ChatConversationViewNode | null {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'test-assistant',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: { turn: context.state.turn, step: context.state.step },
    }
  },
}

interface TestProjection {
  readonly timeline: ConversationTimelineSnapshot
  readonly chat: readonly ChatConversationViewNode[]
}

async function projectConversation(events: readonly unknown[]): Promise<TestProjection> {
  const ConversationNodeAssembler = await loadConversationNodeAssembler()
  const timelineView: ConversationViewDefinition = {
    target: 'test-timeline',
    create() {
      const empty: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }
      return {
        empty,
        replace: input => input.timeline,
        apply: input => input.timeline,
      }
    },
  }
  const chatView: ConversationViewDefinition<ChatConversationViewNode, readonly ChatConversationViewNode[]> = {
    target: 'chat',
    create() {
      const sort = (nodes: readonly ChatConversationViewNode[]) => [...nodes].sort((left, right) => left.anchorSeq - right.anchorSeq)
      return {
        empty: [],
        replace: input => sort(input.nodes),
        apply: input => sort(input.upserts),
      }
    },
  }
  const assembler = new ConversationNodeAssembler(
    {
      entries: () => [claudeTurnDefinition, claudeActivityStepDefinition, assistantTestDefinition],
      fallbackEntry: () => undefined,
    },
    { entries: () => [timelineView, chatView] },
  )
  assembler.replaceWindow(events.map(event => ({ event, view: undefined })) as never, false)
  assembler.flush()
  return {
    timeline: assembler.snapshot('test-timeline') as ConversationTimelineSnapshot,
    chat: assembler.snapshot('chat') as readonly ChatConversationViewNode[],
  }
}

describe('Claude sidecar conversation projection', () => {
  it('folds task and nested subagent lifecycle within one turn', () => {
    const rows = activityRowsForTurn([taskCall, nestedStarted, nestedDone, taskDone], 2)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      running: false,
      activity: { title: 'Tool completed', toolName: 'Task' },
      subcalls: [{ toolUseId: 'sub-1', phase: 'completed', toolName: 'Read' }],
    })
    expect(activityRowsForTurn([taskCall], 1)).toEqual([])
    expect(activityRowsForStep([
      taskCall,
      { ...taskCall, step: 2, ordinal: 2, toolUseId: 'task-2' },
      { ...taskCall, turn: 3, ordinal: 3, toolUseId: 'task-3' },
    ], 2, 1)).toEqual([expect.objectContaining({ activity: taskCall })])
  })

  it('settles historical task progress from the authoritative task snapshot', () => {
    const progress: ClaudeActivityEvent = {
      turn: 2,
      step: 1,
      ordinal: 5,
      kind: 'subagent',
      phase: 'updated',
      taskId: 'subagent-1',
      title: 'Running inspect files',
    }
    expect(activityRowsForStep([progress], 2, 1, [
      { taskId: 'subagent-1', description: 'inspect files', status: 'completed' },
    ])).toEqual([expect.objectContaining({
      running: false,
      activity: expect.objectContaining({ phase: 'completed', title: 'inspect files' }),
    })])
    expect(activityRowsForStep([progress], 2, 1, [
      { taskId: 'subagent-1', description: 'inspect files', status: 'running' },
    ])).toEqual([expect.objectContaining({ running: true })])
    expect(activityRowsForStep([progress], 2, 1, [
      { taskId: 'subagent-1', description: 'inspect files', status: 'failed' },
    ])).toEqual([expect.objectContaining({
      running: false,
      activity: expect.objectContaining({ phase: 'failed', isError: true }),
    })])
  })

  it('selects task groups, client-local clear state, activity, and origin-turn launchers', () => {
    const tasks = [
      { taskId: 'running-2', description: 'two', status: 'running' as const, originTurn: 2 },
      { taskId: 'running-3', description: 'three', status: 'running' as const, originTurn: 3 },
      { taskId: 'done', description: 'done', status: 'completed' as const, originTurn: 2 },
    ]
    expect(visibleTaskGroups(tasks, new Set())).toMatchObject({
      running: [{ taskId: 'running-2' }, { taskId: 'running-3' }],
      finished: [{ taskId: 'done' }],
    })
    expect(visibleTaskGroups(tasks, new Set(['done'])).finished).toEqual([])
    expect(runningTasksForTurn(tasks, 2).map(task => task.taskId)).toEqual(['running-2'])
    const activities = [
      { ...nestedStarted, taskId: 'running-2' },
      { ...nestedDone, taskId: 'running-3' },
    ]
    expect(activitiesForTask(activities, 'running-2')).toEqual([activities[0]])
  })

  it('renders the Tasks launcher only for Claude-owned sessions', () => {
    const props = {
      t: (key: string) => key,
      isOpen: () => false,
      toggle: () => {},
      subscribe: () => () => {},
    }
    const render = (owned: boolean) => renderToStaticMarkup(createElement(ClaudeTasksHeaderButton, {
      ...props as never,
      useClaudeProjection: ((selector: (projection: unknown) => unknown) => selector({ owned, activities: [] })) as never,
    }))
    expect(render(false)).toBe('')
    expect(render(true)).toContain('dsh-claude-tasks-trigger')
  })

  it('publishes one marker when a Claude turn contains multiple assistant steps', async () => {
    const turnStart = { type: 'turn/start', seq: 1, time: 1, data: { turn: 2 } }
    const assistant = (seq: number, step: number, provider = 'claude-code-cli') => ({
      type: 'assistant/message',
      seq,
      time: seq,
      data: {
        turn: 2,
        step,
        message: { role: 'assistant', content: [], source: { provider, model: 'default' } },
      },
    })
    const projection = await projectConversation([
      turnStart,
      { type: 'step/start', seq: 2, time: 2, data: { turn: 2, step: 1 } },
      assistant(3, 1),
      { type: 'step/end', seq: 4, time: 4, data: { turn: 2, step: 1 } },
      { type: 'step/start', seq: 5, time: 5, data: { turn: 2, step: 2 } },
      assistant(6, 2),
      { type: 'step/end', seq: 7, time: 7, data: { turn: 2, step: 2 } },
      { type: 'turn/end', seq: 8, time: 8, data: { turn: 2 } },
    ])
    expect(claudeTurnDefinition.match(turnStart as never)).toEqual({ id: '2', role: 'start' })
    expect(claudeTurnDefinition.match(assistant(3, 1) as never)).toEqual({ id: '2', role: 'update' })
    expect(projection.timeline.turns.get(2)?.data.get('claudeCode')).toEqual({ turn: 2 })
    expect(projection.chat.map(node => [node.kind, node.data])).toEqual([
      ['claude-activity-step', { turn: 2, step: 1 }],
      ['test-assistant', { turn: 2, step: 1 }],
      ['claude-activity-step', { turn: 2, step: 2 }],
      ['test-assistant', { turn: 2, step: 2 }],
    ])
    expect(projection.chat[0]?.anchorSeq).toBeLessThan(projection.chat[1]?.anchorSeq ?? 0)
    expect(projection.chat[0]?.location.kind).toBe('step')
    expect(projection.chat[2]?.anchorSeq).toBeLessThan(projection.chat[3]?.anchorSeq ?? 0)

    const native = await projectConversation([
      turnStart,
      { type: 'step/start', seq: 2, time: 2, data: { turn: 2, step: 1 } },
      assistant(3, 1, 'native'),
    ])
    expect(native.timeline.turns.get(2)?.data.get('claudeCode')).toBeUndefined()
    expect(native.chat.map(node => node.kind)).toEqual(['test-assistant'])
  })

  it('selects the turn tail from engine-owned turn data', () => {
    expect(selectClaudeTurn({
      turn: { data: { get: () => ({ turn: 2 }) } },
    } as never)).toEqual({ turn: 2 })
    expect(selectClaudeTurn({ turn: { data: { get: () => undefined } } } as never)).toBeNull()
  })
})
