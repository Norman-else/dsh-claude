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
  claudeActiveTasksDefinition,
  claudeActivityStepDefinition,
  claudeTurnDefinition,
  selectClaudeTurn,
} from '../src/client/conversation-sidecar.ts'
import {
  activitiesForTask,
  ClaudeTasksPanel,
  summarizeTurnTasks,
  tasksForTurn,
  visibleTaskGroups,
} from '../src/client/ClaudeTasksPanel.tsx'
import { ClaudeActivityTail } from '../src/client/ClaudeActivityTail.tsx'
import { ClaudeActiveTasksNode } from '../src/client/ClaudeActiveTasksNode.tsx'

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

const userTestDefinition: ConversationNodeDefinition<{ readonly seq: number }> = {
  kind: 'test-user',
  target: 'chat',
  match(event) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return null
    return { id: String(event.data.id), role: 'start' }
  },
  start(_context, match) {
    return { seq: match.event.seq }
  },
  update(context) {
    return context.state
  },
  buildViewNode(context): ChatConversationViewNode | null {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'test-user',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: {},
    }
  },
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

async function conversationAssembler(): Promise<InstanceType<typeof ConversationNodeAssemblerType>> {
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
      let current: readonly ChatConversationViewNode[] = []
      const visible = (nodes: readonly ChatConversationViewNode[]) => nodes
        .filter(node => node.visibility !== 'hidden')
        .sort((left, right) => left.anchorSeq - right.anchorSeq)
      return {
        empty: [],
        replace: input => {
          current = input.nodes
          return visible(current)
        },
        apply: input => {
          const upserts = new Map(input.upserts.map(node => [node.key, node]))
          current = [
            ...current.map(node => upserts.get(node.key) ?? node),
            ...input.upserts.filter(node => !current.some(existing => existing.key === node.key)),
          ]
          return visible(current)
        },
      }
    },
  }
  return new ConversationNodeAssembler(
    {
      entries: () => [claudeTurnDefinition, claudeActivityStepDefinition, claudeActiveTasksDefinition, userTestDefinition, assistantTestDefinition],
      fallbackEntry: () => undefined,
    },
    { entries: () => [timelineView, chatView] },
  )
}

async function projectConversation(events: readonly unknown[]): Promise<TestProjection> {
  const assembler = await conversationAssembler()
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

  it('folds task lifecycle messages sharing a taskId into one settled row', () => {
    const started: ClaudeActivityEvent = {
      turn: 2,
      step: 1,
      ordinal: 5,
      kind: 'subagent',
      phase: 'started',
      taskId: 'background-1',
      title: 'Inspect files',
    }
    const completed: ClaudeActivityEvent = {
      ...started,
      ordinal: 6,
      phase: 'completed',
      summary: 'Inspect files',
    }

    expect(activityRowsForStep([started, completed], 2, 1)).toEqual([expect.objectContaining({
      running: false,
      activity: expect.objectContaining({ taskId: 'background-1', phase: 'completed' }),
    })])
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
    expect(tasksForTurn(tasks, 2).map(task => task.taskId)).toEqual(['running-2', 'done'])
    expect(summarizeTurnTasks(tasksForTurn(tasks, 2))).toEqual({
      state: 'running', count: 2, running: 1, failed: 0, completed: 1,
    })
    expect(summarizeTurnTasks([{ taskId: 'failed', description: 'failed', status: 'failed' }])).toEqual({
      state: 'failed', count: 1, running: 0, failed: 1, completed: 0,
    })
    expect(summarizeTurnTasks([{ taskId: 'done', description: 'done', status: 'completed' }])).toEqual({
      state: 'completed', count: 1, running: 0, failed: 0, completed: 1,
    })
    const activities = [
      { ...nestedStarted, taskId: 'running-2' },
      { ...nestedDone, taskId: 'running-3' },
    ]
    expect(activitiesForTask(activities, 'running-2')).toEqual([activities[0]])
  })

  it('renders a turn-bound Tasks launcher only when that turn has tasks', () => {
    const render = (tasks: readonly unknown[], turn = 2) => renderToStaticMarkup(createElement(ClaudeActivityTail, {
      matched: { turn },
      t: ((key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`) as never,
      openTasks: () => {},
      useClaudeProjection: ((selector: (projection: unknown) => unknown) => selector({ owned: true, activities: [], tasks: { tasks } })) as never,
    }))
    expect(render([])).toBe('')
    expect(render([{ taskId: 'other', description: 'other', status: 'running', originTurn: 3 }])).toBe('')
    expect(render([{ taskId: 'running', description: 'run', status: 'running', originTurn: 2 }])).toContain('tasksTurnRunning')
    expect(render([{ taskId: 'done', description: 'done', status: 'completed', originTurn: 2 }])).toContain('tasksTurnCompleted')
    expect(render([{ taskId: 'failed', description: 'failed', status: 'failed', originTurn: 2 }])).toContain('tasksTurnFailed')
  })

  it('renders the active task node reactively for the owning turn', () => {
    const render = (tasks: readonly unknown[], turn = 2) => renderToStaticMarkup(createElement(ClaudeActiveTasksNode, {
      node: { data: { turn } },
      t: ((key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`) as never,
      openTasks: () => {},
      useClaudeProjection: ((selector: (projection: unknown) => unknown) => selector({ owned: true, activities: [], tasks: { tasks } })) as never,
    } as never))
    expect(render([])).toBe('')
    expect(render([{ taskId: 'other', description: 'other', status: 'running', originTurn: 3 }])).toBe('')
    expect(render([{ taskId: 'running', description: 'run', status: 'running', originTurn: 2 }])).toContain('tasksTurnRunning')
    expect(render([{ taskId: 'done', description: 'done', status: 'completed', originTurn: 2 }])).toContain('tasksTurnCompleted')
  })

  it('mounts the active task node at turn/start and hides it at turn/end', async () => {
    const turnStart = { type: 'turn/start', seq: 1, time: 1, data: { turn: 2 } }
    const stepStart = { type: 'step/start', seq: 2, time: 2, data: { turn: 2, step: 1 } }
    const active = await projectConversation([turnStart, stepStart])
    expect(active.chat.map(node => [node.kind, node.data])).toEqual([
      ['claude-active-tasks', { turn: 2 }],
    ])

    const completed = await projectConversation([
      turnStart,
      stepStart,
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 2 } },
    ])
    expect(completed.chat).toEqual([])
  })

  it('keeps an active turn task launcher after its direct user message before assistant output', async () => {
    const assembler = await conversationAssembler()
    const events = [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], source: { provider: 'claude', model: 'default' } },
        },
      },
      { type: 'step/end', seq: 4, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 5, data: { turn: 1 } },
      { type: 'turn/start', seq: 6, time: 6, data: { turn: 2 } },
      { type: 'step/start', seq: 7, time: 7, data: { turn: 2, step: 1 } },
      {
        type: 'user/message',
        seq: 8,
        time: 8,
        data: {
          id: 'turn-2-user',
          role: 'user',
          content: [{ type: 'text', text: 'Handle the PR comments' }],
          source: { kind: 'user' },
        },
      },
    ]

    for (const event of events) {
      assembler.append({ event, view: undefined } as never)
      expect(() => assembler.flush()).not.toThrow()
    }

    const chat = assembler.snapshot('chat') as readonly ChatConversationViewNode[]
    expect(chat.slice(-2).map(node => node.kind)).toEqual([
      'test-user',
      'claude-active-tasks',
    ])
    expect(chat.at(-2)?.anchorSeq).toBeLessThan(chat.at(-1)?.anchorSeq ?? 0)
    expect(chat.at(-1)).toMatchObject({
      kind: 'claude-active-tasks',
      visibility: 'visible',
      data: { turn: 2 },
    })
  })

  it('keeps incremental projection alive for a second turn after the first turn ends', async () => {
    const assembler = await conversationAssembler()
    const assistant = (seq: number, turn: number) => ({
      type: 'assistant/message',
      seq,
      time: seq,
      data: {
        turn,
        step: 1,
        message: { role: 'assistant', content: [], source: { provider: 'claude', model: 'default' } },
      },
    })
    const events = [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
      assistant(3, 1),
      { type: 'step/end', seq: 4, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 5, data: { turn: 1 } },
      { type: 'turn/start', seq: 6, time: 6, data: { turn: 2 } },
      { type: 'step/start', seq: 7, time: 7, data: { turn: 2, step: 1 } },
      assistant(8, 2),
      { type: 'step/end', seq: 9, time: 9, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 10, time: 10, data: { turn: 2 } },
    ]

    for (const event of events) {
      assembler.append({ event, view: undefined } as never)
      expect(() => assembler.flush()).not.toThrow()
    }

    const timeline = assembler.snapshot('test-timeline') as ConversationTimelineSnapshot
    expect(timeline.turnOrder).toEqual([1, 2])
    expect(timeline.turns.get(1)?.data.get('claudeCode')).toEqual({ turn: 1 })
    expect(timeline.turns.get(2)?.data.get('claudeCode')).toEqual({ turn: 2 })
    const chat = assembler.snapshot('chat') as readonly ChatConversationViewNode[]
    expect(chat.filter(node => node.kind === 'test-assistant').map(node => node.data)).toEqual([
      { turn: 1, step: 1 },
      { turn: 2, step: 1 },
    ])
  })

  it('renders only the selected turn in the Tasks details panel', () => {
    const markup = renderToStaticMarkup(createElement(ClaudeTasksPanel, {
      turn: 2,
      t: ((key: string) => key) as never,
      closeDetails: () => {},
      useClaudeProjection: ((selector: (projection: unknown) => unknown) => selector({
        owned: true,
        activities: [],
        tasks: { tasks: [
          { taskId: 'turn-2', description: 'Task for selected turn', status: 'completed', originTurn: 2 },
          { taskId: 'turn-3', description: 'Task for other turn', status: 'completed', originTurn: 3 },
        ] },
      })) as never,
    }))
    expect(markup).toContain('Task for selected turn')
    expect(markup).not.toContain('Task for other turn')
    expect(markup).toContain('tasksPanelTurn')
  })

  it('publishes one marker when a Claude turn contains multiple assistant steps', async () => {
    const turnStart = { type: 'turn/start', seq: 1, time: 1, data: { turn: 2 } }
    const assistant = (seq: number, step: number, provider = 'claude') => ({
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
    // The generic active-turn anchor exists, but its renderer remains null
    // because a native turn has no Claude sidecar tasks.
    expect(native.chat.map(node => node.kind)).toEqual(['test-assistant', 'claude-active-tasks'])
  })

  it('selects the turn tail from engine-owned turn data', () => {
    expect(selectClaudeTurn({
      turn: { data: { get: () => ({ turn: 2 }) } },
    } as never)).toEqual({ turn: 2 })
    expect(selectClaudeTurn({ turn: { data: { get: () => undefined } } } as never)).toBeNull()
  })
})
