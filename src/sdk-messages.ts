import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeUsage } from './events.ts'

export type NormalizedSdkMessage =
  | { kind: 'init'; sessionId: string; cliVersion: string; cwd: string }
  | { kind: 'text-delta'; text: string; parentToolUseId?: string }
  | { kind: 'assistant-text'; text: string; parentToolUseId?: string }
  | { kind: 'thinking'; text: string; phase: 'updated' | 'completed'; parentToolUseId?: string }
  | { kind: 'tool-call'; toolUseId: string; toolName: string; input: unknown; parentToolUseId?: string }
  | { kind: 'tool-result'; toolUseId: string; output: unknown; isError: boolean; parentToolUseId?: string }
  | {
    kind: 'subagent'
    title: string
    summary?: string
    detail?: unknown
    phase: 'started' | 'updated' | 'completed' | 'failed'
    /** Structured task-board fields for task_started/progress/updated/notification. */
    taskId?: string
    taskStatus?: 'running' | 'completed' | 'failed' | 'stopped' | 'killed'
    description?: string
    subagentType?: string
    taskType?: string
    lastToolName?: string
    usage?: { totalTokens?: number; toolUses?: number; durationMs?: number }
    /** Ambient/housekeeping task: hide from chat rows, keep on the task board. */
    skipTranscript?: boolean
  }
  | {
    /** Level signal: full live background-task set (REPLACE semantics). */
    kind: 'background-tasks'
    tasks: readonly { taskId: string; taskType?: string; description: string }[]
  }
  | { kind: 'status'; title: string; summary?: string; detail?: unknown }
  | { kind: 'warning'; title: string; summary?: string; detail?: unknown }
  | { kind: 'permission-denied'; toolUseId: string; toolName: string; summary: string }
  | { kind: 'result'; success: boolean; text?: string; errors?: readonly string[]; usage: ClaudeUsage; sessionId: string; userMessageUuid?: string; terminalReason?: string; permissionDenials?: readonly { toolName: string; toolUseId: string }[] }
  | { kind: 'protocol-error'; title: string; detail: unknown }
  | { kind: 'unknown'; title: string; detail: unknown }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(item => {
    const block = record(item)
    if (block?.type === 'text') return string(block.text) ?? ''
    return ''
  }).join('')
}

function taskUsageOf(usage: Record<string, unknown> | undefined): { totalTokens?: number; toolUses?: number; durationMs?: number } | undefined {
  if (usage === undefined) return undefined
  const normalized: { totalTokens?: number; toolUses?: number; durationMs?: number } = {}
  if (typeof usage.total_tokens === 'number') normalized.totalTokens = usage.total_tokens
  if (typeof usage.tool_uses === 'number') normalized.toolUses = usage.tool_uses
  if (typeof usage.duration_ms === 'number') normalized.durationMs = usage.duration_ms
  return Object.keys(normalized).length === 0 ? undefined : normalized
}

function resultUsage(message: Record<string, unknown>): ClaudeUsage {
  const usage = record(message.usage)
  const normalized: ClaudeUsage = {}
  if (usage !== undefined) {
    if (typeof usage.input_tokens === 'number') normalized.inputTokens = usage.input_tokens
    if (typeof usage.output_tokens === 'number') normalized.outputTokens = usage.output_tokens
    if (typeof usage.cache_read_input_tokens === 'number') normalized.cacheReadTokens = usage.cache_read_input_tokens
    if (typeof usage.cache_creation_input_tokens === 'number') normalized.cacheCreationTokens = usage.cache_creation_input_tokens
  }
  if (typeof message.total_cost_usd === 'number') normalized.cumulativeCostUsd = message.total_cost_usd
  return normalized
}

function normalizeAssistant(message: Record<string, unknown>): NormalizedSdkMessage[] {
  const envelope = record(message.message)
  const content = envelope?.content
  if (!Array.isArray(content)) return [{ kind: 'protocol-error', title: 'Malformed Claude assistant message', detail: message }]
  const parentToolUseId = string(message.parent_tool_use_id)
  const normalized: NormalizedSdkMessage[] = []
  for (const item of content) {
    const block = record(item)
    if (block === undefined) continue
    if (block.type === 'text') {
      const text = string(block.text)
      if (text !== undefined && text.length > 0) normalized.push({ kind: 'assistant-text', text, ...(parentToolUseId === undefined ? {} : { parentToolUseId }) })
    } else if (block.type === 'thinking') {
      const text = string(block.thinking)
      if (text !== undefined && text.length > 0) normalized.push({ kind: 'thinking', text, phase: 'completed', ...(parentToolUseId === undefined ? {} : { parentToolUseId }) })
    } else if (block.type === 'tool_use') {
      const toolUseId = string(block.id)
      const toolName = string(block.name)
      if (toolUseId !== undefined && toolName !== undefined) {
        normalized.push({
          kind: 'tool-call',
          toolUseId,
          toolName,
          input: block.input,
          ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
        })
      }
    }
  }
  return normalized
}

function normalizeUser(message: Record<string, unknown>): NormalizedSdkMessage[] {
  // CLI ≥ 2.1.238 replays prior user messages (including local-command output
  // echoes with plain string content) when resuming a session. Replays and
  // block-less string echoes carry no tool results; they are not protocol
  // failures and must never kill the session.
  if (message.isReplay === true) return []
  const envelope = record(message.message)
  const content = envelope?.content
  if (typeof content === 'string') return []
  if (!Array.isArray(content)) return [{ kind: 'protocol-error', title: 'Malformed Claude user message', detail: message }]
  const parentToolUseId = string(message.parent_tool_use_id)
  const normalized: NormalizedSdkMessage[] = []
  for (const item of content) {
    const block = record(item)
    if (block?.type !== 'tool_result') continue
    const toolUseId = string(block.tool_use_id)
    if (toolUseId === undefined) continue
    normalized.push({
      kind: 'tool-result',
      toolUseId,
      output: message.tool_use_result ?? block.content,
      isError: block.is_error === true,
      ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
    })
  }
  return normalized
}

function normalizeSystem(message: Record<string, unknown>): NormalizedSdkMessage[] {
  const subtype = string(message.subtype)
  if (subtype === 'init') {
    const sessionId = string(message.session_id)
    const cliVersion = string(message.claude_code_version)
    const cwd = string(message.cwd)
    return sessionId !== undefined && cliVersion !== undefined && cwd !== undefined
      ? [{ kind: 'init', sessionId, cliVersion, cwd }]
      : [{ kind: 'protocol-error', title: 'Malformed Claude initialization message', detail: message }]
  }
  if (subtype === 'status') {
    const status = message.status
    if (status === null) return [{ kind: 'status', title: 'Claude Code is ready' }]
    return [{ kind: 'status', title: `Claude Code ${String(status)}`, detail: message }]
  }
  if (subtype === 'session_state_changed') {
    return [{ kind: 'status', title: `Claude session ${String(message.state)}` }]
  }
  if (subtype === 'permission_denied') {
    const toolUseId = string(message.tool_use_id)
    const toolName = string(message.tool_name)
    if (toolUseId !== undefined && toolName !== undefined) {
      return [{
        kind: 'permission-denied',
        toolUseId,
        toolName,
        summary: string(message.message) ?? 'Claude Code denied the action',
      }]
    }
  }
  if (subtype === 'task_started') {
    const taskId = string(message.task_id)
    const description = string(message.description)
    const subagentType = string(message.subagent_type)
    const taskType = string(message.task_type)
    return [{
      kind: 'subagent',
      title: description ?? taskId ?? 'Claude subagent started',
      phase: 'started',
      detail: message,
      ...(taskId === undefined ? {} : { taskId }),
      taskStatus: 'running' as const,
      ...(description === undefined ? {} : { description }),
      ...(subagentType === undefined ? {} : { subagentType }),
      ...(taskType === undefined ? {} : { taskType }),
      ...(message.skip_transcript === true ? { skipTranscript: true } : {}),
    }]
  }
  if (subtype === 'task_progress') {
    const taskId = string(message.task_id)
    const description = string(message.description)
    const summary = string(message.summary)
    const subagentType = string(message.subagent_type)
    const lastToolName = string(message.last_tool_name)
    const usage = taskUsageOf(record(message.usage))
    return [{
      kind: 'subagent',
      title: summary ?? description ?? 'Claude subagent update',
      phase: 'updated',
      detail: message,
      ...(taskId === undefined ? {} : { taskId }),
      taskStatus: 'running' as const,
      ...(description === undefined ? {} : { description }),
      ...(subagentType === undefined ? {} : { subagentType }),
      ...(lastToolName === undefined ? {} : { lastToolName }),
      ...(summary === undefined ? {} : { summary }),
      ...(usage === undefined ? {} : { usage }),
    }]
  }
  if (subtype === 'task_updated') {
    const patch = record(message.patch)
    const status = string(patch?.status)
    const taskId = string(message.task_id)
    const description = string(patch?.description)
    const error = string(patch?.error)
    const taskStatus = status === undefined
      ? undefined
      : status === 'killed'
        ? 'killed' as const
        : status === 'completed'
          ? 'completed' as const
          : status === 'failed'
            ? 'failed' as const
            : 'running' as const
    return [{
      kind: 'subagent',
      title: description ?? 'Claude subagent update',
      phase: status === 'failed' || status === 'killed' ? 'failed' : status === 'completed' ? 'completed' : 'updated',
      detail: message,
      ...(taskId === undefined ? {} : { taskId }),
      ...(taskStatus === undefined ? {} : { taskStatus }),
      ...(description === undefined ? {} : { description }),
      ...(error === undefined ? {} : { summary: error }),
    }]
  }
  if (subtype === 'task_notification') {
    const failed = message.status === 'failed'
    const stopped = message.status === 'stopped' || message.status === 'cancelled'
    const taskId = string(message.task_id)
    const summary = string(message.summary)
    const taskStatus = failed ? 'failed' as const : stopped ? 'stopped' as const : 'completed' as const
    const usage = taskUsageOf(record(message.usage))
    return [{
      kind: 'subagent',
      title: summary ?? taskId ?? 'Claude subagent finished',
      phase: failed || stopped ? 'failed' : 'completed',
      detail: message,
      ...(taskId === undefined ? {} : { taskId }),
      taskStatus,
      ...(summary === undefined ? {} : { summary }),
      ...(usage === undefined ? {} : { usage }),
    }]
  }
  if (subtype === 'background_tasks_changed') {
    const tasks = Array.isArray(message.tasks) ? message.tasks : []
    return [{
      kind: 'background-tasks',
      tasks: tasks.flatMap(item => {
        const entry = record(item)
        const taskId = string(entry?.task_id)
        const description = string(entry?.description)
        const taskType = string(entry?.task_type)
        if (taskId === undefined || description === undefined) return []
        return [{
          taskId,
          description,
          ...(taskType === undefined ? {} : { taskType }),
        }]
      }),
    }]
  }
  if (subtype === 'api_retry') {
    return [{ kind: 'warning', title: 'Claude API retry', detail: message }]
  }
  if (subtype === 'informational' || subtype === 'notification' || subtype === 'local_command_output') {
    return [{
      kind: message.level === 'warning' ? 'warning' : 'status',
      title: string(message.content) ?? string(message.text) ?? 'Claude Code notice',
      detail: message,
    }]
  }
  if (subtype?.startsWith('hook_') === true || subtype === 'plugin_install') {
    return [{ kind: 'status', title: `Claude Code ${subtype.replaceAll('_', ' ')}`, detail: message }]
  }
  if (subtype !== undefined) {
    // Preserve unknown system lifecycle evidence (background tasks, resets,
    // worker/mirror lifecycle) as a bounded activity instead of silently
    // dropping it; the activity layer redacts and bounds the detail.
    return [{ kind: 'status', title: `Claude Code ${subtype.replaceAll('_', ' ')}`, detail: message }]
  }
  return []
}

const RESULT_ERROR_SUBTYPES = new Set([
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
])

export function normalizeSdkMessage(message: SDKMessage): NormalizedSdkMessage[] {
  const value = message as unknown as Record<string, unknown>
  if (value.type === 'stream_event') {
    const event = record(value.event)
    const parentToolUseId = string(value.parent_tool_use_id)
    if (event?.type === 'content_block_delta') {
      const delta = record(event.delta)
      if (delta?.type === 'text_delta') {
        const text = string(delta.text)
        return text === undefined ? [] : [{ kind: 'text-delta', text, ...(parentToolUseId === undefined ? {} : { parentToolUseId }) }]
      }
      if (delta?.type === 'thinking_delta') {
        const text = string(delta.thinking)
        return text === undefined ? [] : [{ kind: 'thinking', text, phase: 'updated', ...(parentToolUseId === undefined ? {} : { parentToolUseId }) }]
      }
    }
    return []
  }
  if (value.type === 'assistant') return normalizeAssistant(value)
  if (value.type === 'user') return normalizeUser(value)
  if (value.type === 'system') return normalizeSystem(value)
  if (value.type === 'result') {
    const sessionId = string(value.session_id)
    if (sessionId === undefined || (value.subtype !== 'success' && !RESULT_ERROR_SUBTYPES.has(String(value.subtype)))) {
      return [{ kind: 'protocol-error', title: 'Malformed Claude result message', detail: value }]
    }
    // A result is a success only when it is not flagged as an error. Local
    // 2.1.233 emits subtype:"success" with is_error:true for API/auth failures
    // (e.g. terminal_reason:"api_error"), so subtype alone is not authoritative.
    const success = value.subtype === 'success' && value.is_error !== true
    const errors = Array.isArray(value.errors)
      ? value.errors.filter((item): item is string => typeof item === 'string')
      : undefined
    const terminalReason = string(value.terminal_reason)
    const userMessageUuid = string(value.user_message_uuid)
    const permissionDenials = Array.isArray(value.permission_denials)
      ? value.permission_denials
          .map(item => record(item))
          .filter((item): item is Record<string, unknown> => item !== undefined)
          .map(item => {
            const toolName = string(item.tool_name)
            const toolUseId = string(item.tool_use_id)
            return toolName === undefined || toolUseId === undefined ? undefined : { toolName, toolUseId }
          })
          .filter((item): item is { toolName: string; toolUseId: string } => item !== undefined)
          .slice(0, 40)
      : undefined
    return [{
      kind: 'result',
      success,
      ...(success && typeof value.result === 'string' ? { text: value.result } : {}),
      ...(errors === undefined ? {} : { errors }),
      ...(terminalReason === undefined ? {} : { terminalReason }),
      ...(permissionDenials === undefined || permissionDenials.length === 0 ? {} : { permissionDenials }),
      usage: resultUsage(value),
      sessionId,
      ...(userMessageUuid === undefined ? {} : { userMessageUuid }),
    }]
  }
  if (value.type === 'auth_status') {
    return [{
      kind: value.error === undefined ? 'status' : 'warning',
      title: value.error === undefined ? 'Claude authentication status changed' : 'Claude authentication failed',
      detail: value.error ?? value.output,
    }]
  }
  if (value.type === 'rate_limit_event') {
    // The CLI pushes subscription-quota status after API activity. Every
    // update stays audit-only ('status' never enters the conversation flow);
    // a blocking state surfaces through the repository status bar badge that
    // reads these titles from the projection instead.
    const info = record(value.rate_limit_info)
    const status = string(info?.status)
    const blocking = status !== undefined && status !== 'allowed'
    return [{
      kind: 'status',
      title: blocking ? 'Claude rate limit is blocking requests' : 'Claude rate limit status changed',
      detail: value.rate_limit_info,
    }]
  }
  return [{ kind: 'unknown', title: `Unknown Claude SDK message: ${String(value.type)}`, detail: value }]
}

export function extractSdkContentText(content: unknown): string {
  return contentText(content)
}
