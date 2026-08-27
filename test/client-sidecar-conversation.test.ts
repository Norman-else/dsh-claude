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
  transcriptItemsForStep,
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
import {
  ClaudeActivityNode,
  ClaudeCompactionDivider,
  ClaudeTranscriptToolGroup,
  ClaudeTranscriptToolItem,
} from '../src/client/ClaudeActivityNode.tsx'

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

  it('interleaves text and consecutive folded tool groups by shared ordinal', () => {
    const activities: ClaudeActivityEvent[] = [
      { turn: 2, step: 1, ordinal: 0, kind: 'text', text: 'I will inspect this.' },
      { turn: 2, step: 1, ordinal: 1, kind: 'tool-call', phase: 'started', toolUseId: 'read-1', toolName: 'Read', detail: 'file.ts' },
      { turn: 2, step: 1, ordinal: 2, kind: 'tool-result', phase: 'completed', toolUseId: 'read-1', detail: 'contents' },
      { turn: 2, step: 1, ordinal: 3, kind: 'warning', phase: 'updated', title: 'Transient tool warning' },
      { turn: 2, step: 1, ordinal: 4, kind: 'tool-call', phase: 'started', toolUseId: 'grep-1', toolName: 'Grep', detail: 'symbol' },
      { turn: 2, step: 1, ordinal: 5, kind: 'tool-result', phase: 'failed', toolUseId: 'grep-1', detail: 'not found', isError: true },
      { turn: 2, step: 1, ordinal: 6, kind: 'text', text: 'I found the cause.' },
      { turn: 2, step: 1, ordinal: 7, kind: 'tool-call', phase: 'started', toolUseId: 'bash-1', toolName: 'Bash', detail: 'pnpm test' },
      { turn: 2, step: 1, ordinal: 8, kind: 'subagent', phase: 'completed', parentToolUseId: 'bash-1', toolUseId: 'nested-1', toolName: 'Read', summary: 'log' },
      { turn: 2, step: 1, ordinal: 9, kind: 'permission', phase: 'denied', toolUseId: 'bash-1', summary: 'rejected' },
      { turn: 2, step: 1, ordinal: 10, kind: 'text', text: 'I could not run it.' },
    ]

    expect(transcriptItemsForStep(activities.reverse(), 2, 1)).toEqual([
      { kind: 'text', ordinal: 0, text: 'I will inspect this.' },
      { kind: 'tools', ordinal: 1, tools: [
        expect.objectContaining({ toolUseId: 'read-1', toolName: 'Read', output: 'contents', phase: 'completed' }),
        expect.objectContaining({ toolUseId: 'grep-1', toolName: 'Grep', output: 'not found', phase: 'failed', isError: true }),
      ] },
      { kind: 'activity', ordinal: 3, row: expect.objectContaining({ activity: expect.objectContaining({ title: 'Transient tool warning' }) }) },
      { kind: 'text', ordinal: 6, text: 'I found the cause.' },
      { kind: 'tools', ordinal: 7, tools: [expect.objectContaining({
        toolUseId: 'bash-1', toolName: 'Bash', phase: 'denied', output: 'rejected', isError: true,
        subcalls: [expect.objectContaining({ toolUseId: 'nested-1', phase: 'completed' })],
      })] },
      { kind: 'text', ordinal: 10, text: 'I could not run it.' },
    ])
  })

  it('derives readable descriptions and successful edit diffs for one tool group', () => {
    const activities: ClaudeActivityEvent[] = [
      {
        turn: 2, step: 1, ordinal: 1, kind: 'tool-call', phase: 'started', toolUseId: 'grep-1', toolName: 'Grep',
        detail: JSON.stringify({ pattern: 'external payment', path: 'services/accounting-service' }),
      },
      { turn: 2, step: 1, ordinal: 2, kind: 'tool-result', phase: 'completed', toolUseId: 'grep-1', detail: 'match.ts' },
      {
        turn: 2, step: 1, ordinal: 3, kind: 'tool-call', phase: 'started', toolUseId: 'edit-1', toolName: 'Edit',
        detail: JSON.stringify({ file_path: 'src/ReceivableService.java', old_string: 'old line', new_string: 'new line\nsecond line' }),
      },
      { turn: 2, step: 1, ordinal: 4, kind: 'tool-result', phase: 'completed', toolUseId: 'edit-1', detail: 'updated' },
      {
        turn: 2, step: 1, ordinal: 5, kind: 'tool-call', phase: 'started', toolUseId: 'write-failed', toolName: 'Write',
        detail: JSON.stringify({ file_path: 'src/Failed.java', content: 'not applied' }),
      },
      { turn: 2, step: 1, ordinal: 6, kind: 'tool-result', phase: 'failed', toolUseId: 'write-failed', detail: 'denied', isError: true },
    ]

    const group = transcriptItemsForStep(activities, 2, 1)[0]
    expect(group).toMatchObject({
      kind: 'tools',
      additions: 2,
      deletions: 1,
      files: 1,
      tools: [
        { description: 'Searched services/accounting-service for external payment' },
        {
          description: 'Edited src/ReceivableService.java',
          additions: 2,
          deletions: 1,
          diffs: [{ path: 'src/ReceivableService.java', oldText: 'old line', newText: 'new line\nsecond line' }],
        },
        { description: 'Failed to write src/Failed.java' },
      ],
    })
    if (group?.kind !== 'tools') throw new Error('Expected a tool group')
    expect(group.tools[2]).not.toHaveProperty('diffs')
    expect(group.tools[2]).not.toHaveProperty('additions')
    expect(group.tools[2]).not.toHaveProperty('deletions')
  })

  it('renders the tool-group row without a background card and includes diff statistics', () => {
    const markup = renderToStaticMarkup(createElement(ClaudeTranscriptToolGroup, {
      tools: [{
        toolUseId: 'edit-1',
        toolName: 'Edit',
        description: 'Edited file.ts',
        phase: 'completed',
        additions: 2,
        deletions: 1,
        diffs: [{ path: 'file.ts', oldText: 'old', newText: 'new\nline' }],
        subcalls: [],
      }],
      additions: 2,
      deletions: 1,
      files: 1,
      t: ((key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`) as never,
    }))

    expect(markup).toContain('dsh-claude-tool-group-native')
    expect(markup).not.toContain('dsh-claude-tool-group-card')
    expect(markup).toContain('+2')
    expect(markup).toContain('−1')
  })

  it('splits the transcript at a compaction boundary instead of dropping it', () => {
    const activities: ClaudeActivityEvent[] = [
      { turn: 2, step: 1, ordinal: 0, kind: 'text', text: 'Before compaction.' },
      { turn: 2, step: 1, ordinal: 1, kind: 'tool-call', phase: 'started', toolUseId: 'read-1', toolName: 'Read', detail: '{"file_path":"a.ts"}' },
      { turn: 2, step: 1, ordinal: 2, kind: 'tool-result', phase: 'completed', toolUseId: 'read-1', detail: 'contents' },
      {
        turn: 2, step: 1, ordinal: 3, kind: 'compaction', phase: 'completed',
        title: 'Claude compacted the conversation',
        detail: JSON.stringify({ trigger: 'manual', preTokens: 128_000, postTokens: 32_000, durationMs: 4_200 }),
      },
      { turn: 2, step: 1, ordinal: 4, kind: 'text', text: 'After compaction.' },
    ]

    // The boundary closes the open tool group: it separates prose rather than
    // reporting work, so it can never land inside one group.
    expect(transcriptItemsForStep(activities, 2, 1)).toEqual([
      { kind: 'text', ordinal: 0, text: 'Before compaction.' },
      { kind: 'tools', ordinal: 1, tools: [expect.objectContaining({ toolUseId: 'read-1' })] },
      { kind: 'compaction', ordinal: 3, compaction: { trigger: 'manual', preTokens: 128_000, postTokens: 32_000 } },
      { kind: 'text', ordinal: 4, text: 'After compaction.' },
    ])
  })

  it('reads a metadata-less compaction boundary without inventing figures', () => {
    const activities: ClaudeActivityEvent[] = [
      { turn: 2, step: 1, ordinal: 0, kind: 'compaction', phase: 'completed', detail: '{}' },
      { turn: 2, step: 1, ordinal: 1, kind: 'compaction', phase: 'completed' },
    ]

    expect(transcriptItemsForStep(activities, 2, 1)).toEqual([
      { kind: 'compaction', ordinal: 0, compaction: {} },
      { kind: 'compaction', ordinal: 1, compaction: {} },
    ])
  })

  it('renders the compaction divider with token figures only when both are known', () => {
    const render = (compaction: Parameters<typeof ClaudeCompactionDivider>[0]['compaction']) =>
      renderToStaticMarkup(createElement(ClaudeCompactionDivider, {
        compaction,
        t: ((key: string) => key) as never,
      }))

    expect(render({ trigger: 'manual', preTokens: 128_000, postTokens: 32_000 }))
      .toContain('compacted · 128K → 32K')
    expect(render({ trigger: 'auto', preTokens: 128_000, postTokens: 32_000 }))
      .toContain('compactedAuto · 128K → 32K')
    // A half-reported boundary still draws the rule; it just says less.
    const partial = render({ preTokens: 128_000 })
    expect(partial).toContain('compacted')
    expect(partial).not.toContain('→')
    expect(partial).toContain('role="separator"')
  })

  it('renders sidecar text and tools from the unified transcript', () => {
    const markup = renderToStaticMarkup(createElement(ClaudeActivityNode, {
      node: { data: { turn: 2, step: 1 } },
      t: ((key: string) => key) as never,
      useClaudeProjection: ((selector: (projection: unknown) => unknown) => selector({
        activities: [
          {
            turn: 2,
            step: 1,
            ordinal: 0,
            kind: 'text',
            text: '## Sidecar assistant text',
          },
          {
            turn: 2,
            step: 1,
            ordinal: 1,
            kind: 'tool-call',
            phase: 'started',
            toolUseId: 'read-1',
            toolName: 'Read',
            detail: JSON.stringify({ file_path: 'README.md' }),
          },
        ],
        tasks: { tasks: [] },
      })) as never,
    } as never))

    expect(markup).toContain('dsh-claude-tool-group-native')
    expect(markup).toContain('Sidecar assistant text')
    expect(markup).toContain('dsh-claude-transcript-text')
  })

  it('keeps each tool entry in an independent collapsed disclosure', () => {
    const markup = renderToStaticMarkup(createElement('div', null,
      createElement(ClaudeTranscriptToolItem, {
        tool: {
          toolUseId: 'glob-1',
          toolName: 'Glob',
          phase: 'completed',
          input: '{"pattern":"**/*.ts"}',
          output: 'file.ts',
          subcalls: [],
        },
        t: ((key: string) => key) as never,
      }),
      createElement(ClaudeTranscriptToolItem, {
        tool: {
          toolUseId: 'grep-1',
          toolName: 'Grep',
          phase: 'completed',
          input: '{"pattern":"external payment"}',
          output: 'match.ts',
          subcalls: [],
        },
        t: ((key: string) => key) as never,
      }),
    ))

    expect(markup.match(/<details/g)).toHaveLength(2)
    expect(markup).not.toContain('<details open=""')
    expect(markup).toContain('<summary')
    expect(markup).toContain('file.ts')
    expect(markup).toContain('match.ts')
    expect(markup).toContain('Glob')
    expect(markup).toContain('Grep')
  })

  it('renders semantic Read, search, terminal, diff, and unknown tool details without protocol JSON walls', () => {
    const render = (tool: Parameters<typeof ClaudeTranscriptToolItem>[0]['tool']) => renderToStaticMarkup(createElement(ClaudeTranscriptToolItem, {
      tool,
      t: ((key: string) => key) as never,
    }))

    const read = render({
      toolUseId: 'read-1', toolName: 'Read', description: 'Read src/example.ts', subcalls: [],
      input: JSON.stringify({ file_path: 'src/example.ts', offset: 10, limit: 2 }),
      output: JSON.stringify({ type: 'text', file: { filePath: 'src/example.ts', content: 'const one = 1\nconst two = 2' } }),
    })
    expect(read).toContain('src/example.ts')
    expect(read).toContain('<span class="dsh-claude-tool-line-number">10</span>')
    expect(read).toContain('const one = 1')
    expect(read).not.toContain('&quot;filePath&quot;')

    const grep = render({
      toolUseId: 'grep-1', toolName: 'Grep', description: 'Searched for symbol', subcalls: [],
      input: JSON.stringify({ pattern: 'symbol', output_mode: 'files_with_matches' }),
      output: JSON.stringify({ mode: 'files_with_matches', filenames: ['src/a.ts', 'src/b.ts'], numFiles: 2 }),
    })
    expect(grep).toContain('src/a.ts')
    expect(grep).toContain('src/b.ts')
    expect(grep).not.toContain('&quot;filenames&quot;')

    const bash = render({
      toolUseId: 'bash-1', toolName: 'Bash', description: 'Ran tests', subcalls: [],
      input: JSON.stringify({ command: 'pnpm test', description: 'Run tests' }),
      output: JSON.stringify({ stdout: '18 passed', stderr: '', interrupted: false }),
    })
    expect(bash).toContain('pnpm test')
    expect(bash).toContain('18 passed')
    expect(bash).not.toContain('&quot;stdout&quot;')

    const diff = render({
      toolUseId: 'edit-1', toolName: 'Edit', description: 'Edited src/a.ts', subcalls: [],
      diffs: [{ path: 'src/a.ts', oldText: 'old', newText: 'new' }],
      input: JSON.stringify({ file_path: 'src/a.ts', old_string: 'old', new_string: 'new' }),
      output: JSON.stringify({ success: true }),
    })
    expect(diff).toContain('src/a.ts')
    expect(diff).not.toContain('old_string')

    const unknown = render({
      toolUseId: 'mcp-1', toolName: 'mcp__service__lookup', description: 'Lookup item', subcalls: [],
      input: JSON.stringify({ item_id: 'item-1', include_history: true }),
      output: JSON.stringify({ status: 'found', count: 1 }),
    })
    expect(unknown).toContain('item id')
    expect(unknown).toContain('include history')
    expect(unknown).toContain('found')
    expect(unknown).not.toContain('&quot;item_id&quot;')
  })

  it('keeps foreground Bash only in its tool group while retaining background and subagent lifecycle rows', () => {
    const activities: ClaudeActivityEvent[] = [
      { turn: 2, step: 1, ordinal: 1, kind: 'tool-call', phase: 'started', toolUseId: 'bash-1', toolName: 'Bash', detail: JSON.stringify({ command: 'pnpm test' }) },
      { turn: 2, step: 1, ordinal: 2, kind: 'subagent', phase: 'started', taskId: 'foreground', title: 'Run tests' },
      { turn: 2, step: 1, ordinal: 3, kind: 'tool-result', phase: 'completed', toolUseId: 'bash-1', detail: 'passed' },
      { turn: 2, step: 1, ordinal: 4, kind: 'subagent', phase: 'started', taskId: 'background', title: 'Watch logs' },
      { turn: 2, step: 1, ordinal: 5, kind: 'subagent', phase: 'started', taskId: 'agent', title: 'Explore code' },
    ]
    const tasks = [
      { taskId: 'foreground', description: 'Run tests', status: 'completed' as const, taskType: 'local_bash' },
      { taskId: 'background', description: 'Watch logs', status: 'running' as const, taskType: 'local_bash', backgrounded: true },
      { taskId: 'agent', description: 'Explore code', status: 'running' as const, subagentType: 'Explore' },
    ]

    expect(transcriptItemsForStep(activities, 2, 1)).toEqual([
      expect.objectContaining({ kind: 'tools', tools: [expect.objectContaining({ toolUseId: 'bash-1' })] }),
    ])

    const items = transcriptItemsForStep(activities, 2, 1, tasks)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ kind: 'tools', tools: [{ toolUseId: 'bash-1', output: 'passed' }] })
    expect(items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'activity', row: expect.objectContaining({ activity: expect.objectContaining({ taskId: 'foreground' }) }) }),
    ]))
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'activity', row: expect.objectContaining({ activity: expect.objectContaining({ taskId: 'background' }) }) }),
      expect.objectContaining({ kind: 'activity', row: expect.objectContaining({ activity: expect.objectContaining({ taskId: 'agent' }) }) }),
    ]))
    expect(tasksForTurn([
      { ...tasks[0]!, originTurn: 2 },
      { ...tasks[1]!, originTurn: 2 },
      { ...tasks[2]!, originTurn: 2 },
    ], 2).map(task => task.taskId)).toEqual(['background', 'agent'])
  })

  it('hides uncorrelated lifecycle noise while keeping classified background work', () => {
    const uncorrelated: ClaudeActivityEvent = {
      turn: 2, step: 1, ordinal: 1, kind: 'subagent', phase: 'updated', title: 'Claude subagent update',
    }
    const unknownTask: ClaudeActivityEvent = {
      turn: 2, step: 1, ordinal: 2, kind: 'subagent', phase: 'started', taskId: 'unknown', title: 'Push branch',
    }
    const background: ClaudeActivityEvent = {
      turn: 2, step: 1, ordinal: 3, kind: 'subagent', phase: 'completed', taskId: 'background', title: 'Run full test suite',
    }
    expect(transcriptItemsForStep([uncorrelated, unknownTask, background], 2, 1, [
      { taskId: 'background', description: 'Run full test suite', status: 'completed', taskType: 'local_bash', backgrounded: true },
    ])).toEqual([
      expect.objectContaining({ kind: 'activity', row: expect.objectContaining({ activity: expect.objectContaining({ taskId: 'background' }) }) }),
    ])
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

    expect(activityRowsForStep([started, completed], 2, 1, [
      { taskId: 'background-1', description: 'Inspect files', status: 'completed', backgrounded: true },
    ])).toEqual([expect.objectContaining({
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
      { taskId: 'subagent-1', description: 'inspect files', status: 'completed', subagentType: 'Explore' },
    ])).toEqual([expect.objectContaining({
      running: false,
      activity: expect.objectContaining({ phase: 'completed', title: 'inspect files' }),
    })])
    expect(activityRowsForStep([progress], 2, 1, [
      { taskId: 'subagent-1', description: 'inspect files', status: 'running', subagentType: 'Explore' },
    ])).toEqual([expect.objectContaining({ running: true })])
    expect(activityRowsForStep([progress], 2, 1, [
      { taskId: 'subagent-1', description: 'inspect files', status: 'failed', subagentType: 'Explore' },
    ])).toEqual([expect.objectContaining({
      running: false,
      activity: expect.objectContaining({ phase: 'failed', isError: true }),
    })])
  })

  it('selects task groups, client-local clear state, activity, and origin-turn launchers', () => {
    const tasks = [
      { taskId: 'running-2', description: 'two', status: 'running' as const, originTurn: 2, backgrounded: true },
      { taskId: 'running-3', description: 'three', status: 'running' as const, originTurn: 3, subagentType: 'Explore' },
      { taskId: 'done', description: 'done', status: 'completed' as const, originTurn: 2, subagentType: 'general-purpose' },
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

  it('renders a compact turn-bound Tasks launcher only for background work and subagents', () => {
    const render = (tasks: readonly unknown[], turn = 2) => renderToStaticMarkup(createElement(ClaudeActivityTail, {
      matched: { turn },
      t: ((key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`) as never,
      openTasks: () => {},
      useClaudeProjection: ((selector: (projection: unknown) => unknown) => selector({ owned: true, activities: [], tasks: { tasks } })) as never,
    }))
    expect(render([])).toBe('')
    expect(render([{ taskId: 'other', description: 'other', status: 'running', originTurn: 3, backgrounded: true }])).toBe('')
    expect(render([{ taskId: 'foreground', description: 'foreground', status: 'completed', originTurn: 2, taskType: 'local_bash' }])).toBe('')
    const running = render([{ taskId: 'running', description: 'run', status: 'running', originTurn: 2, backgrounded: true }])
    expect(running).toContain('tasksTurnRunning')
    expect(running).toContain('tasksOpen')
    expect(running).toContain('border-radius:999px')
    expect(running).toContain('justify-content:flex-start')
    expect(running).toContain('tasksTurnRunning:{&quot;count&quot;:1}</span>')
    expect(running).toContain('dsh-claude-act-running')
    const mixed = render([
      { taskId: 'running', description: 'run', status: 'running', originTurn: 2, backgrounded: true },
      { taskId: 'done', description: 'done', status: 'completed', originTurn: 2, subagentType: 'Explore' },
      { taskId: 'failed', description: 'failed', status: 'failed', originTurn: 2, subagentType: 'general-purpose' },
    ])
    expect(mixed).toContain('tasksTurnRunning:{&quot;count&quot;:1}</span>')
    const done = render([{ taskId: 'done', description: 'done', status: 'completed', originTurn: 2, subagentType: 'Explore' }])
    expect(done).toContain('tasksTurnCompleted')
    expect(done).not.toContain('dsh-claude-act-running')
    expect(render([{ taskId: 'failed', description: 'failed', status: 'failed', originTurn: 2, subagentType: 'general-purpose' }])).toContain('tasksTurnFailed')
  })

  it('renders the active task node reactively for the owning turn', () => {
    const render = (tasks: readonly unknown[], turn = 2) => renderToStaticMarkup(createElement(ClaudeActiveTasksNode, {
      node: { data: { turn } },
      t: ((key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`) as never,
      openTasks: () => {},
      useClaudeProjection: ((selector: (projection: unknown) => unknown) => selector({ owned: true, activities: [], tasks: { tasks } })) as never,
    } as never))
    expect(render([])).toBe('')
    expect(render([{ taskId: 'other', description: 'other', status: 'running', originTurn: 3, backgrounded: true }])).toBe('')
    expect(render([{ taskId: 'foreground', description: 'foreground', status: 'running', originTurn: 2, taskType: 'local_bash' }])).toBe('')
    expect(render([{ taskId: 'running', description: 'run', status: 'running', originTurn: 2, backgrounded: true }])).toContain('tasksTurnRunning')
    expect(render([{ taskId: 'done', description: 'done', status: 'completed', originTurn: 2, subagentType: 'Explore' }])).toContain('tasksTurnCompleted')
  })

  it('mounts live Claude activity at step/start and hides the active task node at turn/end', async () => {
    const turnStart = { type: 'turn/start', seq: 1, time: 1, data: { turn: 2 } }
    const stepStart = { type: 'step/start', seq: 2, time: 2, data: { turn: 2, step: 1 } }
    const active = await projectConversation([turnStart, stepStart])
    expect(active.chat.map(node => [node.kind, node.data])).toEqual([
      ['claude-activity-step', { turn: 2, step: 1 }],
      ['claude-active-tasks', { turn: 2 }],
    ])
    expect(active.chat[0]?.anchorSeq).toBeLessThan(active.chat[1]?.anchorSeq ?? 0)

    const completed = await projectConversation([
      turnStart,
      stepStart,
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 2 } },
    ])
    expect(completed.chat.map(node => [node.kind, node.data])).toEqual([
      ['claude-activity-step', { turn: 2, step: 1 }],
    ])
  })

  it('keeps cancelled partial Claude activity before the next user message', async () => {
    const projection = await projectConversation([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 3, time: 3, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 5,
        time: 5,
        data: {
          id: 'after-cancel',
          role: 'user',
          content: [{ type: 'text', text: 'Use a different approach' }],
          source: { kind: 'user' },
        },
      },
    ])

    expect(projection.chat.map(node => node.kind)).toEqual([
      'claude-activity-step',
      'test-user',
    ])
    expect(projection.chat[0]?.anchorSeq).toBeLessThan(projection.chat[1]?.anchorSeq ?? 0)
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
    expect(chat.slice(-3).map(node => node.kind)).toEqual([
      'test-user',
      'claude-activity-step',
      'claude-active-tasks',
    ])
    expect(chat.at(-3)?.anchorSeq).toBeLessThan(chat.at(-2)?.anchorSeq ?? 0)
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
          { taskId: 'turn-2', description: 'Task for selected turn', status: 'completed', originTurn: 2, subagentType: 'Explore' },
          { taskId: 'turn-3', description: 'Task for other turn', status: 'completed', originTurn: 3, backgrounded: true },
        ] },
      })) as never,
    }))
    expect(markup).toContain('Task for selected turn')
    expect(markup).not.toContain('Task for other turn')
    expect(markup).toContain('tasksPanelTurn')
    expect(markup).toContain('class="dshClaudeDetailsCard"')
    expect(markup).toContain('.dshClaudeDetailsCard {\n  box-sizing: border-box;\n  width: calc(100% - 16px);\n  height: calc(100% - 16px);\n  margin: 8px;')
    expect(markup).toContain('border-radius:12px')
    expect(markup).toContain('box-shadow:0 4px 16px')
    expect(markup).toMatch(/class="dshClaudePanelIconButton" aria-label="tasksClose"[^>]*><svg\b/u)
    expect(markup).not.toContain('>×</button>')
    expect(markup).toContain('.dshClaudePanelIconButton:hover')
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
    // Generic live anchors exist, but their renderers stay null when a native
    // turn has no Claude sidecar activities or tasks.
    expect(native.chat.map(node => node.kind)).toEqual(['test-assistant', 'claude-active-tasks', 'claude-activity-step'])
  })

  it('selects the turn tail from engine-owned turn data', () => {
    expect(selectClaudeTurn({
      turn: { data: { get: () => ({ turn: 2 }) } },
    } as never)).toEqual({ turn: 2 })
    expect(selectClaudeTurn({ turn: { data: { get: () => undefined } } } as never)).toBeNull()
  })
})
