import { KNOWN_SESSION_EVENT_TYPES, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CLAUDE_ACTIVITY_EVENT,
  CLAUDE_SESSION_BOUND_EVENT,
  SDK_VERSION,
} from './constants.ts'

export type ClaudeActivityKind =
  | 'status'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'permission'
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
  toolUseId?: string
  toolName?: string
  title?: string
  summary?: string
  detail?: string
  isError?: boolean
  usage?: ClaudeUsage
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'claude-code/session-bound': ClaudeSessionBoundEvent
    'claude-code/activity': ClaudeActivityEvent
  }
}

const SECRET_KEY = /(?:^|[_-])(password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|session[_-]?key)(?:$|[_-])/i
const MAX_SUMMARY_CHARS = 1_000
const MAX_DETAIL_CHARS = 4_000
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

export function installClaudeEventVocabulary(): void {
  if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('dsh-claude-code: this Harness build does not expose an extensible session event vocabulary')
  }
  KNOWN_SESSION_EVENT_TYPES.add(CLAUDE_SESSION_BOUND_EVENT)
  KNOWN_SESSION_EVENT_TYPES.add(CLAUDE_ACTIVITY_EVENT)
}

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
  if (activity.toolUseId !== undefined) normalized.toolUseId = redactText(activity.toolUseId, 256)
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
  if (activity.isError !== undefined) normalized.isError = activity.isError
  if (activity.usage !== undefined) normalized.usage = { ...activity.usage }
  return normalized
}

export interface ClaudeActivityCursor {
  turn: number
  step: number
  nextOrdinal: number
}

export function currentClaudeActivityCursor(events: readonly SessionEvent[]): ClaudeActivityCursor {
  let turn = 0
  let step = 0
  let nextOrdinal = 0
  for (const event of events) {
    if (event.type === 'step/start') {
      const data = event.data as { turn: number; step: number }
      turn = data.turn
      step = data.step
      nextOrdinal = 0
    } else if (event.type === CLAUDE_ACTIVITY_EVENT) {
      const activity = event.data as ClaudeActivityEvent
      if (activity.turn === turn && activity.step === step) {
        nextOrdinal = Math.max(nextOrdinal, activity.ordinal + 1)
      }
    }
  }
  if (turn < 1 || step < 1) {
    throw new Error('dsh-claude-code: Claude activity requires an open DSH step')
  }
  return { turn, step, nextOrdinal }
}

export type ClaudeActivityInput = Omit<
  ClaudeActivityEvent,
  'turn' | 'step' | 'ordinal' | 'summary' | 'detail'
> & {
  summary?: unknown
  detail?: unknown
}

export async function appendClaudeActivity(
  agent: Agent,
  cursor: ClaudeActivityCursor,
  activity: ClaudeActivityInput,
): Promise<ClaudeActivityEvent> {
  const normalized = normalizeActivity({
    ...activity,
    turn: cursor.turn,
    step: cursor.step,
    ordinal: cursor.nextOrdinal++,
  })
  await agent.session.append(CLAUDE_ACTIVITY_EVENT, normalized)
  return normalized
}

export async function appendClaudeSessionBinding(
  agent: Agent,
  binding: Omit<ClaudeSessionBoundEvent, 'sdkVersion'> & { sdkVersion?: string },
): Promise<ClaudeSessionBoundEvent> {
  const payload: ClaudeSessionBoundEvent = {
    claudeSessionId: binding.claudeSessionId,
    sdkVersion: binding.sdkVersion ?? SDK_VERSION,
    cwd: binding.cwd,
  }
  if (binding.cliVersion !== undefined) payload.cliVersion = binding.cliVersion
  await agent.session.append(CLAUDE_SESSION_BOUND_EVENT, payload)
  return payload
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
