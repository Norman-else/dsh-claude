import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClaudeActivityEvent, ClaudeActivityPhase, ClaudeTaskInfo } from '../events.ts'
import { CLAUDE_CODE_PROVIDER, TASK_TOOL_NAMES } from '../constants.ts'

export interface ClaudeSubcall {
  toolUseId: string
  toolName?: string
  phase?: ClaudeActivityPhase
  summary?: string
  isError?: boolean
}

export interface ClaudeActivityChatData {
  activity: ClaudeActivityEvent
  running: boolean
  subcalls: readonly ClaudeSubcall[]
}

export interface ClaudeTurnMarker {
  readonly turn: number
}

export interface ClaudeActivityStepMarker {
  readonly turn: number
  readonly step: number
}

interface ClaudeTurnProjectionState extends ClaudeTurnMarker {
  readonly claude: boolean
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    claudeCode: ClaudeTurnMarker
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'claude-activity-step': ClaudeActivityStepMarker
  }
}

function isTaskActivity(value: ClaudeActivityEvent): boolean {
  return (value.kind === 'tool-call' || value.kind === 'tool-result')
    && value.toolName !== undefined
    && TASK_TOOL_NAMES.has(value.toolName)
}

export function presentable(activity: ClaudeActivityEvent): boolean {
  if (isTaskActivity(activity)) return true
  if (activity.kind === 'tool-call' || activity.kind === 'tool-result') return false
  if (activity.isError === true) return true
  if (activity.title?.startsWith('Unknown Claude SDK message') === true) return false
  switch (activity.kind) {
    case 'subagent':
    case 'permission':
    case 'warning':
    case 'error':
      return true
    case 'thinking':
      return activity.summary !== undefined && activity.summary.length > 0
    default:
      return false
  }
}

function running(activity: ClaudeActivityEvent): boolean {
  return activity.phase === 'started' || activity.phase === 'updated'
}

function subcallOf(value: ClaudeActivityEvent): ClaudeSubcall | undefined {
  if (value.kind !== 'subagent' || value.toolUseId === undefined) return undefined
  return {
    toolUseId: value.toolUseId,
    ...(value.toolName === undefined ? {} : { toolName: value.toolName }),
    ...(value.phase === undefined ? {} : { phase: value.phase }),
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(value.isError === undefined ? {} : { isError: value.isError }),
  }
}

/** Fold raw sidecar activity into the same lifecycle cards the old event projection rendered. */
function activityRows(
  activities: readonly ClaudeActivityEvent[],
  accepts: (activity: ClaudeActivityEvent) => boolean,
  tasks: readonly ClaudeTaskInfo[] = [],
): readonly ClaudeActivityChatData[] {
  const rows: ClaudeActivityChatData[] = []
  const byId = new Map<string, number>()
  for (const value of activities) {
    if (!accepts(value)) continue
    const existingTaskId = value.toolUseId === undefined ? undefined : `task-${value.toolUseId}`
    const updatesExistingTask = value.kind === 'tool-result'
      && existingTaskId !== undefined
      && byId.has(existingTaskId)
    if (!presentable(value) && !updatesExistingTask) continue
    let id: string
    if ((isTaskActivity(value) || updatesExistingTask) && existingTaskId !== undefined) id = existingTaskId
    else if (value.kind === 'subagent' && value.parentToolUseId !== undefined) id = `task-${value.parentToolUseId}`
    else if (value.kind === 'subagent' && value.taskId !== undefined) id = `subagent-task-${value.taskId}`
    else if (value.kind === 'subagent' && value.toolUseId !== undefined) id = `call-${value.toolUseId}`
    else id = `act-${value.turn}-${value.step}-${value.ordinal}`
    const index = byId.get(id)
    if (index === undefined) {
      byId.set(id, rows.length)
      rows.push({ activity: value, running: running(value), subcalls: [] })
      continue
    }
    const previous = rows[index]
    if (previous === undefined) continue
    if (value.kind === 'subagent' && value.parentToolUseId !== undefined) {
      const nested = subcallOf(value)
      if (nested === undefined) continue
      const nestedIndex = previous.subcalls.findIndex(item => item.toolUseId === nested.toolUseId)
      const subcalls = nestedIndex === -1
        ? [...previous.subcalls, nested]
        : previous.subcalls.map((item, position) => position === nestedIndex ? { ...item, ...nested } : item)
      rows[index] = { ...previous, subcalls }
      continue
    }
    rows[index] = {
      activity: {
        ...value,
        ...(value.toolName === undefined && previous.activity.toolName !== undefined
          ? { toolName: previous.activity.toolName }
          : {}),
      },
      running: running(value),
      subcalls: previous.subcalls,
    }
  }
  const taskStatus = new Map(tasks.map(task => [task.taskId, task.status]))
  return rows.map(row => {
    const taskId = row.activity.taskId
    const status = taskId === undefined ? undefined : taskStatus.get(taskId)
    if (status === undefined || status === 'running') return row
    const failed = status === 'failed' || status === 'stopped' || status === 'killed'
    const settledTitle = row.activity.title?.replace(/^Running\s+/u, '')
    return {
      ...row,
      running: false,
      activity: {
        ...row.activity,
        phase: failed ? 'failed' : 'completed',
        ...(settledTitle === undefined ? {} : { title: settledTitle }),
        ...(failed ? { isError: true } : {}),
      },
    }
  })
}

export function activityRowsForTurn(
  activities: readonly ClaudeActivityEvent[],
  turn: number,
  tasks: readonly ClaudeTaskInfo[] = [],
): readonly ClaudeActivityChatData[] {
  return activityRows(activities, activity => activity.turn === turn, tasks)
}

export function activityRowsForStep(
  activities: readonly ClaudeActivityEvent[],
  turn: number,
  step: number,
  tasks: readonly ClaudeTaskInfo[] = [],
): readonly ClaudeActivityChatData[] {
  return activityRows(activities, activity => activity.turn === turn && activity.step === step, tasks)
}

interface ClaudeActivityStepState extends ClaudeActivityStepMarker {
  readonly assistantSeq?: number
}

/** Anchor one sidecar-backed activity group immediately before its Claude assistant step. */
export const claudeActivityStepDefinition: ConversationNodeDefinition<ClaudeActivityStepState> = {
  kind: 'claude-activity-step',
  target: 'chat',
  match(event) {
    if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (event.type !== 'assistant/message' || event.data.message.source.provider !== CLAUDE_CODE_PROVIDER) return null
    return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
  },
  start(_context, match) {
    if (match.event.type !== 'step/start') throw new Error('Claude activity step requires step/start')
    return { turn: match.event.data.turn, step: match.event.data.step }
  },
  update(context, match) {
    if (match.event.type !== 'assistant/message') throw new Error('Claude activity step update requires assistant/message')
    return { ...context.state, assistantSeq: match.event.seq }
  },
  buildViewNode(context): ChatConversationViewNode | null {
    const state = context.state
    if (state?.assistantSeq === undefined) return null
    return {
      key: context.key,
      kind: 'claude-activity-step',
      id: context.id,
      target: 'chat',
      anchorSeq: state.assistantSeq - 0.1,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: { turn: state.turn, step: state.step },
    }
  },
}

/** Publish a marker for turns containing standard assistant output from the Claude adapter. */
export const claudeTurnDefinition: ConversationNodeDefinition<ClaudeTurnProjectionState> = {
  kind: 'claudeCode',
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type !== 'assistant/message' || event.data.message.source.provider !== CLAUDE_CODE_PROVIDER) return null
    return { id: String(event.data.turn), role: 'update' }
  },
  start(_context, match) {
    if (match.event.type !== 'turn/start') throw new Error('Claude turn marker requires turn/start')
    return { turn: match.event.data.turn, claude: false }
  },
  update(context, match) {
    if (match.event.type !== 'assistant/message') throw new Error('Claude turn marker update requires assistant/message')
    return context.state.claude ? context.state : { turn: context.state.turn, claude: true }
  },
  buildLocationData(context, scope) {
    if (scope !== 'turn' || context.state?.claude !== true) return null
    const value: ClaudeTurnMarker = { turn: context.state.turn }
    return { kind: 'turn', turn: context.state.turn, key: 'claudeCode', value }
  },
}

/** Pure chain selector: only Claude-produced turns mount the sidecar-backed tail. */
export function selectClaudeTurn(owner: TurnTailOwnerProps): ClaudeTurnMarker | null {
  return owner.turn.data.get('claudeCode') ?? null
}
