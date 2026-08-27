import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClaudeActivityEvent, ClaudeActivityPhase, ClaudeTaskInfo } from '../events.ts'
import { CLAUDE_CODE_PROVIDER, TASK_TOOL_NAMES } from '../constants.ts'
import { isProjectedTaskActivity } from './task-projection.ts'

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

export interface ClaudeTranscriptDiff {
  path: string
  oldText: string | null
  newText: string
}

export interface ClaudeTranscriptTool {
  toolUseId: string
  toolName: string
  description: string
  summary?: string
  input?: string
  output?: string
  phase?: ClaudeActivityPhase
  isError?: boolean
  additions?: number
  deletions?: number
  diffs?: readonly ClaudeTranscriptDiff[]
  subcalls: readonly ClaudeSubcall[]
}

export interface ClaudeCompaction {
  trigger?: 'manual' | 'auto'
  preTokens?: number
  postTokens?: number
}

export type ClaudeTranscriptItem =
  | { kind: 'text'; ordinal: number; text: string }
  | { kind: 'tools'; ordinal: number; tools: readonly ClaudeTranscriptTool[]; additions?: number; deletions?: number; files?: number }
  | { kind: 'activity'; ordinal: number; row: ClaudeActivityChatData }
  | { kind: 'compaction'; ordinal: number; compaction: ClaudeCompaction }

export interface ClaudeTurnMarker {
  readonly turn: number
}

export interface ClaudeActivityStepMarker {
  readonly turn: number
  readonly step: number
}

export interface ClaudeActiveTasksMarker {
  readonly turn: number
}

interface ClaudeActiveTasksState extends ClaudeActiveTasksMarker {
  readonly active: boolean
  readonly anchored: boolean
  readonly anchorSeq: number
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
    'claude-active-tasks': ClaudeActiveTasksMarker
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
      // 'compaction' stays out of the disclosure rows on purpose: the
      // transcript draws it as a divider instead, in `transcriptItemsForStep`.
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
    if (!accepts(value) || !isProjectedTaskActivity(value, tasks)) continue
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

function inputRecord(detail: string | undefined): Record<string, unknown> | undefined {
  if (detail === undefined) return undefined
  try {
    const value: unknown = JSON.parse(detail)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function inputString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read the compaction figures the supervisor stored as redacted JSON detail.
 *  Every field is optional: an older CLI reports the boundary without metadata,
 *  and the divider still renders — just without the token counts. */
function compactionOf(activity: ClaudeActivityEvent): ClaudeCompaction {
  const detail = inputRecord(activity.detail)
  const trigger = detail?.trigger
  const preTokens = detail?.preTokens
  const postTokens = detail?.postTokens
  return {
    ...(trigger === 'manual' || trigger === 'auto' ? { trigger } : {}),
    ...(typeof preTokens === 'number' ? { preTokens } : {}),
    ...(typeof postTokens === 'number' ? { postTokens } : {}),
  }
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/u).length
}

function editDiffs(toolName: string, input: Record<string, unknown> | undefined): readonly ClaudeTranscriptDiff[] | undefined {
  const path = inputString(input, 'file_path')
  if (path === undefined) return undefined
  if (toolName === 'MultiEdit' && Array.isArray(input?.edits)) {
    const diffs = input.edits.flatMap(edit => {
      if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) return []
      const item = edit as Record<string, unknown>
      const newText = inputString(item, 'new_string')
      if (newText === undefined) return []
      return [{ path, oldText: inputString(item, 'old_string') ?? null, newText }]
    })
    return diffs.length === 0 ? undefined : diffs
  }
  if (toolName === 'Edit') {
    const newText = inputString(input, 'new_string')
    return newText === undefined ? undefined : [{ path, oldText: inputString(input, 'old_string') ?? null, newText }]
  }
  if (toolName === 'Write') {
    const content = inputString(input, 'content')
    return content === undefined ? undefined : [{ path, oldText: null, newText: content }]
  }
  return undefined
}

function toolDescription(toolName: string, input: Record<string, unknown> | undefined, failed = false): string {
  const path = inputString(input, 'file_path') ?? inputString(input, 'path')
  const pattern = inputString(input, 'pattern') ?? inputString(input, 'query')
  const description = inputString(input, 'description')
  const target = path ?? pattern
  let completed: string
  let failedAction: string
  switch (toolName) {
    case 'Grep':
      completed = path === undefined ? `Searched for ${pattern ?? 'matches'}` : `Searched ${path} for ${pattern ?? 'matches'}`
      failedAction = path === undefined ? `search for ${pattern ?? 'matches'}` : `search ${path} for ${pattern ?? 'matches'}`
      break
    case 'Glob':
      completed = `Searched for ${pattern ?? 'files'}`
      failedAction = `search for ${pattern ?? 'files'}`
      break
    case 'Read':
      completed = `Read ${path ?? 'a file'}`
      failedAction = `read ${path ?? 'a file'}`
      break
    case 'WebFetch': {
      const url = inputString(input, 'url') ?? 'a web page'
      completed = `Fetched ${url}`
      failedAction = `fetch ${url}`
      break
    }
    case 'WebSearch':
      completed = `Searched the web for ${pattern ?? 'results'}`
      failedAction = `search the web for ${pattern ?? 'results'}`
      break
    case 'Edit': case 'MultiEdit':
      completed = `Edited ${path ?? 'a file'}`
      failedAction = `edit ${path ?? 'a file'}`
      break
    case 'Write':
      completed = `Wrote ${path ?? 'a file'}`
      failedAction = `write ${path ?? 'a file'}`
      break
    case 'Bash': {
      const command = inputString(input, 'command') ?? 'a command'
      completed = description ?? `Ran ${command}`
      failedAction = description === undefined ? `run ${command}` : description
      break
    }
    default:
      completed = description ?? `${toolName}${target === undefined ? '' : ` ${target}`}`
      failedAction = completed.charAt(0).toLowerCase() + completed.slice(1)
  }
  return failed ? `Failed to ${failedAction}` : completed
}

/** Fold one step's shared ordinal stream into Claude Code-style prose and tool groups. */
export function transcriptItemsForStep(
  activities: readonly ClaudeActivityEvent[],
  turn: number,
  step: number,
  tasks: readonly ClaudeTaskInfo[] = [],
): readonly ClaudeTranscriptItem[] {
  const ordered = activities
    .filter(activity => activity.turn === turn && activity.step === step)
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal)
  const items: ClaudeTranscriptItem[] = []
  let group: {
    ordinal: number
    tools: ClaudeTranscriptTool[]
    byId: Map<string, number>
    trailingActivities: ClaudeActivityEvent[]
  } | undefined
  const flushGroup = (): void => {
    if (group === undefined || group.tools.length === 0) return
    const current = group
    const diffs = current.tools.flatMap(tool => tool.diffs ?? [])
    const additions = diffs.reduce((total, diff) => total + lineCount(diff.newText), 0)
    const deletions = diffs.reduce((total, diff) => total + (diff.oldText === null ? 0 : lineCount(diff.oldText)), 0)
    const files = new Set(diffs.map(diff => diff.path)).size
    items.push({
      kind: 'tools',
      ordinal: current.ordinal,
      tools: current.tools,
      ...(diffs.length === 0 ? {} : { additions, deletions, files }),
    })
    group = undefined
    for (const activity of current.trailingActivities) {
      const row = activityRows([activity], () => true, tasks)[0]
      if (row !== undefined) items.push({ kind: 'activity', ordinal: activity.ordinal, row })
    }
  }
  for (const activity of ordered) {
    if (!isProjectedTaskActivity(activity, tasks)) continue
    if (activity.kind === 'text') {
      flushGroup()
      if (activity.text !== undefined && activity.text.length > 0) {
        items.push({ kind: 'text', ordinal: activity.ordinal, text: activity.text })
      }
      continue
    }
    if (activity.kind === 'compaction') {
      flushGroup()
      items.push({ kind: 'compaction', ordinal: activity.ordinal, compaction: compactionOf(activity) })
      continue
    }
    if (activity.kind === 'tool-call' && activity.toolUseId !== undefined && activity.toolName !== undefined) {
      group ??= { ordinal: activity.ordinal, tools: [], byId: new Map(), trailingActivities: [] }
      group.byId.set(activity.toolUseId, group.tools.length)
      const input = inputRecord(activity.detail)
      group.tools.push({
        toolUseId: activity.toolUseId,
        toolName: activity.toolName,
        description: toolDescription(activity.toolName, input),
        ...(activity.summary === undefined ? {} : { summary: activity.summary }),
        ...(activity.detail === undefined ? {} : { input: activity.detail }),
        ...(activity.phase === undefined ? {} : { phase: activity.phase }),
        ...(activity.isError === undefined ? {} : { isError: activity.isError }),
        subcalls: [],
      })
      continue
    }
    if ((activity.kind === 'tool-result' || activity.kind === 'permission') && activity.toolUseId !== undefined && group !== undefined) {
      const index = group.byId.get(activity.toolUseId)
      const previous = index === undefined ? undefined : group.tools[index]
      if (index !== undefined && previous !== undefined) {
        const failed = activity.isError === true || activity.phase === 'failed' || activity.kind === 'permission'
        const diffs = failed ? undefined : editDiffs(previous.toolName, inputRecord(previous.input))
        const additions = diffs?.reduce((total, diff) => total + lineCount(diff.newText), 0)
        const deletions = diffs?.reduce((total, diff) => total + (diff.oldText === null ? 0 : lineCount(diff.oldText)), 0)
        group.tools[index] = {
          ...previous,
          description: toolDescription(previous.toolName, inputRecord(previous.input), failed),
          ...(activity.detail === undefined ? {} : { output: activity.detail }),
          ...(activity.phase === undefined ? {} : { phase: activity.phase }),
          ...(activity.isError === undefined ? {} : { isError: activity.isError }),
          ...(diffs === undefined ? {} : { diffs, additions: additions ?? 0, deletions: deletions ?? 0 }),
          ...(activity.kind === 'permission' ? { output: activity.summary, isError: true } : {}),
        }
      }
      continue
    }
    if (activity.kind === 'subagent' && activity.parentToolUseId !== undefined && group !== undefined) {
      const index = group.byId.get(activity.parentToolUseId)
      const previous = index === undefined ? undefined : group.tools[index]
      const nested = subcallOf(activity)
      if (index !== undefined && previous !== undefined && nested !== undefined) {
        const nestedIndex = previous.subcalls.findIndex(item => item.toolUseId === nested.toolUseId)
        const subcalls = nestedIndex === -1
          ? [...previous.subcalls, nested]
          : previous.subcalls.map((item, position) => position === nestedIndex ? { ...item, ...nested } : item)
        group.tools[index] = { ...previous, subcalls }
      }
      continue
    }
    if (!presentable(activity)) continue
    if (group !== undefined) {
      // Only the next top-level assistant prose closes a tool group. Keep any
      // presentable task/warning metadata after that group without splitting
      // consecutive root tools that occurred between the same two prose spans.
      group.trailingActivities.push(activity)
      continue
    }
    const row = activityRows([activity], () => true, tasks)[0]
    if (row !== undefined) items.push({ kind: 'activity', ordinal: activity.ordinal, row })
  }
  flushGroup()
  return items
}

interface ClaudeActivityStepState extends ClaudeActivityStepMarker {
  readonly anchorSeq: number
  readonly assistantSeq?: number
}

/** Keep one sidecar-backed activity group at the live chat tail, then anchor it
 * before the native assistant message or at step settlement when none appears. */
export const claudeActivityStepDefinition: ConversationNodeDefinition<ClaudeActivityStepState> = {
  kind: 'claude-activity-step',
  target: 'chat',
  match(event) {
    if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (event.type === 'step/end') return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    if (event.type !== 'assistant/message' || event.data.message.source.provider !== CLAUDE_CODE_PROVIDER) return null
    return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
  },
  start(_context, match) {
    if (match.event.type !== 'step/start') throw new Error('Claude activity step requires step/start')
    return {
      turn: match.event.data.turn,
      step: match.event.data.step,
      anchorSeq: Number.MAX_SAFE_INTEGER - 1,
    }
  },
  update(context, match) {
    if (match.event.type === 'assistant/message') {
      return { ...context.state, assistantSeq: match.event.seq, anchorSeq: match.event.seq - 0.1 }
    }
    if (match.event.type === 'step/end') {
      return context.state.assistantSeq === undefined
        ? { ...context.state, anchorSeq: match.event.seq - 0.1 }
        : context.state
    }
    throw new Error('Claude activity step update requires assistant/message or step/end')
  },
  buildViewNode(context): ChatConversationViewNode | null {
    const state = context.state
    if (state === undefined) return null
    return {
      key: context.key,
      kind: 'claude-activity-step',
      id: context.id,
      target: 'chat',
      anchorSeq: state.anchorSeq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: { turn: state.turn, step: state.step },
    }
  },
}

/** Keep one sidecar-backed task launcher mounted only while its DSH turn is open. */
export const claudeActiveTasksDefinition: ConversationNodeDefinition<ClaudeActiveTasksState> = {
  kind: 'claude-active-tasks',
  target: 'chat',
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end' || event.type === 'step/start' || event.type === 'assistant/message') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start(_context, match) {
    if (match.event.type !== 'turn/start') throw new Error('Claude active tasks require turn/start')
    // A user/message has no turn coordinate in the public event payload, so it
    // cannot update this turn-keyed Context directly. Keep the launcher at the
    // live chat tail until assistant output provides a concrete later anchor.
    return {
      turn: match.event.data.turn,
      active: true,
      anchored: false,
      anchorSeq: Number.MAX_SAFE_INTEGER,
    }
  },
  update(context, match) {
    if (match.event.type === 'turn/end') return { ...context.state, active: false }
    if (match.event.type === 'step/start' && !context.state.anchored) return context.state
    return { ...context.state, anchored: true, anchorSeq: match.event.seq + 0.1 }
  },
  buildViewNode(context): ChatConversationViewNode | null {
    const state = context.state
    if (state === undefined) return null
    return {
      key: context.key,
      kind: 'claude-active-tasks',
      id: context.id,
      target: 'chat',
      anchorSeq: state.anchorSeq,
      location: context.start?.location ?? { kind: 'unresolved' },
      // Incremental assemblers forbid withdrawing a materialized node. Keep
      // its key stable after turn/end and hide it while the turn tail takes over.
      visibility: state.active ? 'visible' : 'hidden',
      data: { turn: state.turn },
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
