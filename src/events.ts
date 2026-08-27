import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CLAUDE_ACTIVITY_EVENT,
  CLAUDE_CONTEXT_USAGE_EVENT,
  CLAUDE_SESSION_BOUND_EVENT,
  CLAUDE_TASKS_EVENT,
} from './constants.ts'

export type ClaudeActivityKind =
  | 'text'
  | 'status'
  /** Context compaction boundary; the transcript draws it as a divider. */
  | 'compaction'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'permission'
  | 'question'
  | 'subagent'
  | 'usage'
  | 'warning'
  | 'error'

export type ClaudeActivityPhase =
  | 'started'
  | 'updated'
  | 'completed'
  | 'denied'
  | 'failed'

export interface ClaudeUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cumulativeCostUsd?: number
}

export interface ClaudeSessionBoundEvent {
  claudeSessionId: string
  cliVersion?: string
  sdkVersion: string
  cwd: string
}

export interface ClaudeActivityEvent {
  turn: number
  step: number
  ordinal: number
  kind: ClaudeActivityKind
  phase?: ClaudeActivityPhase
  /** Claude task-board identity for lifecycle activity; never a transcript path. */
  taskId?: string
  toolUseId?: string
  /** Enclosing Claude tool call for subagent-nested activity. */
  parentToolUseId?: string
  toolName?: string
  title?: string
  summary?: string
  detail?: string
  /** Redacted visible Claude prose used by the plugin-owned interleaved transcript. */
  text?: string
  isError?: boolean
  usage?: ClaudeUsage
}

export interface ClaudeContextUsageCategory {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
}

export interface ClaudeContextUsageEvent {
  model: string
  totalTokens: number
  maxTokens: number
  percentage: number
  categories: readonly ClaudeContextUsageCategory[]
}

export interface ClaudeContextUsageInput {
  model: unknown
  totalTokens: unknown
  maxTokens: unknown
  percentage: unknown
  categories: readonly {
    name?: unknown
    tokens?: unknown
    color?: unknown
    isDeferred?: unknown
  }[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'claude-code/session-bound': ClaudeSessionBoundEvent
    'claude-code/activity': ClaudeActivityEvent
    'claude-code/context-usage': ClaudeContextUsageEvent
    'claude-code/tasks': ClaudeTasksEvent
  }
}

const SECRET_KEY = /(?:^|[_-])(password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|session[_-]?key|env|environ|environment)(?:$|[_-])/i
const MAX_SUMMARY_CHARS = 1_000
const MAX_DETAIL_CHARS = 4_000
const MAX_TRANSCRIPT_TEXT_CHARS = 64_000
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 40
const MAX_OBJECT_KEYS = 60
const REDACTED = '[REDACTED]'
const TRUNCATED = '…[truncated]'
const SECRET_ASSIGNMENT = /((?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|session[_-]?key)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu
const BEARER_TOKEN = /(\bbearer\s+)[A-Za-z0-9._~+/=-]+/giu
const PREFIXED_TOKEN = /\b(?:sk-(?:ant-|proj-)?|xox[baprs]-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/giu
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/giu
const URL_SECRET_PARAM = /([?&](?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)=)[^&#\s]+/giu

export function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - TRUNCATED.length))}${TRUNCATED}`
}

export function redactText(value: string, maxChars = MAX_DETAIL_CHARS): string {
  return boundText(
    value
      .replace(JWT_TOKEN, REDACTED)
      .replace(PREFIXED_TOKEN, REDACTED)
      .replace(BEARER_TOKEN, `$1${REDACTED}`)
      .replace(URL_USERINFO, `$1${REDACTED}@`)
      .replace(URL_SECRET_PARAM, `$1${REDACTED}`)
      .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`),
    maxChars,
  )
}

export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return null
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message, MAX_SUMMARY_CHARS) }
  }
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => redactValue(item, depth + 1, seen))
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`)
      return items
    }
    const result: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
      result[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1, seen)
    }
    if (entries.length > MAX_OBJECT_KEYS) result.__truncatedKeys = entries.length - MAX_OBJECT_KEYS
    return result
  } finally {
    seen.delete(value)
  }
}

export function safeDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const redacted = redactValue(value)
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted)
  return boundText(text, MAX_DETAIL_CHARS)
}

export function normalizeActivity(
  activity: Omit<ClaudeActivityEvent, 'summary' | 'detail'> & {
    summary?: unknown
    detail?: unknown
  },
): ClaudeActivityEvent {
  const normalized: ClaudeActivityEvent = {
    turn: activity.turn,
    step: activity.step,
    ordinal: activity.ordinal,
    kind: activity.kind,
  }
  if (activity.phase !== undefined) normalized.phase = activity.phase
  if (activity.taskId !== undefined) normalized.taskId = redactText(activity.taskId, 128)
  if (activity.toolUseId !== undefined) normalized.toolUseId = redactText(activity.toolUseId, 256)
  if (activity.parentToolUseId !== undefined) normalized.parentToolUseId = redactText(activity.parentToolUseId, 256)
  if (activity.toolName !== undefined) normalized.toolName = redactText(activity.toolName, 256)
  if (activity.title !== undefined) normalized.title = redactText(activity.title, MAX_SUMMARY_CHARS)
  if (activity.summary !== undefined) {
    normalized.summary = redactText(
      typeof activity.summary === 'string' ? activity.summary : safeDetail(activity.summary) ?? '',
      MAX_SUMMARY_CHARS,
    )
  }
  const detail = safeDetail(activity.detail)
  if (detail !== undefined) normalized.detail = detail
  if (activity.text !== undefined) normalized.text = redactText(activity.text, MAX_TRANSCRIPT_TEXT_CHARS)
  if (activity.isError !== undefined) normalized.isError = activity.isError
  if (activity.usage !== undefined) normalized.usage = { ...activity.usage }
  return normalized
}

const MAX_CONTEXT_CATEGORIES = 24
const FALLBACK_CONTEXT_COLOR = '#8b95a5'
const SAFE_CONTEXT_COLOR = /^#[0-9a-f]{3,8}$/iu

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0
}

export function normalizeContextUsage(input: ClaudeContextUsageInput): ClaudeContextUsageEvent {
  return {
    model: redactText(typeof input.model === 'string' ? input.model : 'unknown', 128),
    totalTokens: nonNegativeInteger(input.totalTokens),
    maxTokens: nonNegativeInteger(input.maxTokens),
    percentage: Math.min(100, nonNegativeInteger(input.percentage)),
    categories: input.categories.slice(0, MAX_CONTEXT_CATEGORIES).map(category => ({
      name: redactText(typeof category.name === 'string' ? category.name : 'Unknown', 128),
      tokens: nonNegativeInteger(category.tokens),
      color: typeof category.color === 'string' && SAFE_CONTEXT_COLOR.test(category.color)
        ? category.color
        : FALLBACK_CONTEXT_COLOR,
      ...(category.isDeferred === true ? { isDeferred: true } : {}),
    })),
  }
}

export function latestClaudeContextUsage(
  events: readonly SessionEvent[],
): ClaudeContextUsageEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === CLAUDE_CONTEXT_USAGE_EVENT) return event.data as ClaudeContextUsageEvent
  }
  return undefined
}

export type ClaudeTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'killed'

export interface ClaudeTaskUsage {
  totalTokens?: number
  toolUses?: number
  durationMs?: number
}

export interface ClaudeTaskInfo {
  taskId: string
  description: string
  status: ClaudeTaskStatus
  /** DSH turn during which this task was first observed, when known. */
  originTurn?: number
  subagentType?: string
  taskType?: string
  lastToolName?: string
  summary?: string
  usage?: ClaudeTaskUsage
  /** True while the task runs detached (background command/subagent). */
  backgrounded?: boolean
}

/** Level snapshot of one session's Claude task board, REPLACE semantics. */
export interface ClaudeTasksEvent {
  tasks: readonly ClaudeTaskInfo[]
}

const MAX_TASKS_PER_SNAPSHOT = 50
const MAX_TASK_TEXT_CHARS = 300

const TASK_STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'failed', 'stopped', 'killed'])

function normalizeTaskUsage(input: ClaudeTaskUsage | undefined): ClaudeTaskUsage | undefined {
  if (input === undefined) return undefined
  const usage: ClaudeTaskUsage = {}
  if (input.totalTokens !== undefined) usage.totalTokens = nonNegativeInteger(input.totalTokens)
  if (input.toolUses !== undefined) usage.toolUses = nonNegativeInteger(input.toolUses)
  if (input.durationMs !== undefined) usage.durationMs = nonNegativeInteger(input.durationMs)
  return Object.keys(usage).length === 0 ? undefined : usage
}

export function normalizeTasksEvent(tasks: readonly ClaudeTaskInfo[]): ClaudeTasksEvent {
  return {
    tasks: tasks.slice(0, MAX_TASKS_PER_SNAPSHOT).map(task => {
      const usage = normalizeTaskUsage(task.usage)
      return {
        taskId: redactText(String(task.taskId), 128),
        description: redactText(String(task.description), MAX_TASK_TEXT_CHARS),
        status: TASK_STATUSES.has(task.status) ? task.status : 'running',
        ...(task.originTurn === undefined ? {} : { originTurn: nonNegativeInteger(task.originTurn) }),
        ...(task.subagentType === undefined ? {} : { subagentType: redactText(task.subagentType, 64) }),
        ...(task.taskType === undefined ? {} : { taskType: redactText(task.taskType, 64) }),
        ...(task.lastToolName === undefined ? {} : { lastToolName: redactText(task.lastToolName, 64) }),
        ...(task.summary === undefined ? {} : { summary: redactText(task.summary, MAX_TASK_TEXT_CHARS) }),
        ...(usage === undefined ? {} : { usage }),
        ...(task.backgrounded === true ? { backgrounded: true } : {}),
      }
    }),
  }
}

export function latestClaudeTasks(
  events: readonly SessionEvent[],
): ClaudeTasksEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === CLAUDE_TASKS_EVENT) return event.data as ClaudeTasksEvent
  }
  return undefined
}

export type ClaudeActivityInput = Omit<
  ClaudeActivityEvent,
  'turn' | 'step' | 'ordinal' | 'summary' | 'detail'
> & {
  summary?: unknown
  detail?: unknown
}

export interface ClaudeActivityCursor {
  turn: number
  step: number
  nextOrdinal: number
}

/** Derive the current DSH turn/step; activity ordinals are completed from the sidecar. */
export function currentClaudeActivityCursor(events: readonly SessionEvent[]): ClaudeActivityCursor {
  let turn = 0
  let step = 0
  for (const event of events) {
    if (event.type !== 'step/start') continue
    const data = event.data as { turn: number; step: number }
    turn = data.turn
    step = data.step
  }
  if (turn < 1 || step < 1) {
    throw new Error('dsh-claude: Claude activity requires an open DSH step')
  }
  return { turn, step, nextOrdinal: 0 }
}

export function latestClaudeSessionBinding(
  events: readonly SessionEvent[],
): ClaudeSessionBoundEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === CLAUDE_SESSION_BOUND_EVENT) {
      return event.data as ClaudeSessionBoundEvent
    }
  }
  return undefined
}
