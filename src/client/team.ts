/**
 * Claude Code's native Agent Team, read off what the sidecar already holds.
 *
 * The CLI runs teammates as `in_process_teammate` tasks, the shared task list
 * through its TaskCreate / TaskUpdate tools, and mail through SendMessage. The
 * task board names the teammates and the activity log carries every tool
 * call's input, so the roster, board, and mailbox are derived here without a
 * second server-side projection.
 */
import type { ClaudeActivityEvent, ClaudeTaskInfo, ClaudeTaskStatus, ClaudeTaskUsage } from '../events.ts'

export const TEAMMATE_TASK_TYPE = 'in_process_teammate'
export const LEAD_NAME = 'lead'

export interface ClaudeTeamMember {
  taskId: string
  name: string
  role: 'lead' | 'teammate'
  status: ClaudeTaskStatus
  description: string
  /** The Agent call that spawned the teammate; its nested calls carry it as parent. */
  toolUseId?: string
  lastToolName?: string
  usage?: ClaudeTaskUsage
}

export type ClaudeTeamTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface ClaudeTeamTask {
  id: string
  subject: string
  description?: string
  status: ClaudeTeamTaskStatus
  owner?: string
  blockedBy: readonly string[]
}

export interface ClaudeTeamMessage {
  ordinal: number
  from: string
  to: string
  summary?: string
  message: string
}

export interface ClaudeTeamView {
  members: readonly ClaudeTeamMember[]
  tasks: readonly ClaudeTeamTask[]
  messages: readonly ClaudeTeamMessage[]
}

export const EMPTY_TEAM: ClaudeTeamView = { members: [], tasks: [], messages: [] }

function parseRecord(detail: string | undefined): Record<string, unknown> | undefined {
  if (detail === undefined) return undefined
  try {
    const value: unknown = JSON.parse(detail)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** The id a TaskCreate result names: a structured `id`, else `#N` in its prose. */
export function createdTaskId(output: string | undefined): string | undefined {
  if (output === undefined) return undefined
  const record = parseRecord(output)
  const structured = record?.id ?? (parseRecord(JSON.stringify(record?.task ?? null)) ?? {}).id
  if (typeof structured === 'string' || typeof structured === 'number') return String(structured)
  const match = /#(\d+)/u.exec(output) ?? /\btask\s+(?:id\s*)?[:#]?\s*(\d+)\b/iu.exec(output)
  return match?.[1]
}

function taskStatus(value: unknown): ClaudeTeamTaskStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined
}

/** Fold the sidecar into the team: teammates from the task board, the shared
 *  task list and mail from the tool calls that wrote them. */
export function deriveTeam(activities: readonly ClaudeActivityEvent[], tasks: readonly ClaudeTaskInfo[]): ClaudeTeamView {
  const teammates = tasks.filter(task => task.taskType === TEAMMATE_TASK_TYPE)
  if (teammates.length === 0 && !activities.some(activity => activity.toolName === 'TaskCreate' || activity.toolName === 'SendMessage')) {
    return EMPTY_TEAM
  }
  const ordered = [...activities].sort((left, right) => left.ordinal - right.ordinal)
  const spawnInputs = new Map<string, Record<string, unknown>>()
  for (const activity of ordered) {
    if (activity.toolUseId !== undefined && activity.toolName !== undefined && activity.phase === 'started') {
      const input = parseRecord(activity.detail)
      if (input !== undefined) spawnInputs.set(activity.toolUseId, input)
    }
  }
  const members: ClaudeTeamMember[] = teammates.map(task => {
    const spawn = task.toolUseId === undefined ? undefined : spawnInputs.get(task.toolUseId)
    return {
      taskId: task.taskId,
      name: text(spawn?.name) ?? task.description,
      role: 'teammate',
      status: task.status,
      description: text(spawn?.description) ?? task.description,
      ...(task.toolUseId === undefined ? {} : { toolUseId: task.toolUseId }),
      ...(task.lastToolName === undefined ? {} : { lastToolName: task.lastToolName }),
      ...(task.usage === undefined ? {} : { usage: task.usage }),
    }
  })
  const nameOfParent = new Map(members.flatMap(member => member.toolUseId === undefined ? [] : [[member.toolUseId, member.name] as const]))
  const senderOf = (activity: ClaudeActivityEvent): string =>
    activity.parentToolUseId === undefined ? LEAD_NAME : nameOfParent.get(activity.parentToolUseId) ?? LEAD_NAME

  const board = new Map<string, ClaudeTeamTask>()
  const pendingCreates = new Map<string, ClaudeTeamTask>()
  const messages: ClaudeTeamMessage[] = []
  const upsert = (id: string, patch: Partial<ClaudeTeamTask>): void => {
    const previous = board.get(id) ?? { id, subject: `#${id}`, status: 'pending' as const, blockedBy: [] }
    board.set(id, { ...previous, ...patch })
  }
  for (const activity of ordered) {
    const toolUseId = activity.toolUseId
    if (toolUseId === undefined) continue
    if (activity.toolName === undefined) {
      // A result: the only one that matters is the id TaskCreate hands back.
      const created = pendingCreates.get(toolUseId)
      if (created === undefined) continue
      pendingCreates.delete(toolUseId)
      if (activity.isError === true || activity.phase === 'failed') continue
      const id = createdTaskId(activity.detail) ?? toolUseId
      upsert(id, { ...created, id })
      continue
    }
    if (activity.phase !== 'started') continue
    const input = parseRecord(activity.detail) ?? {}
    if (activity.toolName === 'TaskCreate') {
      const subject = text(input.subject)
      if (subject === undefined) continue
      const description = text(input.description)
      pendingCreates.set(toolUseId, {
        id: toolUseId,
        subject,
        status: 'pending',
        blockedBy: [],
        ...(description === undefined ? {} : { description }),
      })
    } else if (activity.toolName === 'TaskUpdate') {
      const id = text(input.taskId) ?? (typeof input.taskId === 'number' ? String(input.taskId) : undefined)
      if (id === undefined) continue
      const status = taskStatus(input.status)
      const owner = text(input.owner)
      const subject = text(input.subject)
      const description = text(input.description)
      const blockedBy = strings(input.addBlockedBy)
      const previous = board.get(id)
      upsert(id, {
        ...(status === undefined ? {} : { status }),
        ...(owner === undefined ? {} : { owner }),
        ...(subject === undefined ? {} : { subject }),
        ...(description === undefined ? {} : { description }),
        ...(blockedBy.length === 0 ? {} : { blockedBy: [...new Set([...(previous?.blockedBy ?? []), ...blockedBy])] }),
      })
    } else if (activity.toolName === 'SendMessage') {
      const message = text(input.message) ?? text(input.content)
      if (message === undefined) continue
      const to = text(input.to) ?? strings(input.to).join(', ')
      const summary = text(input.summary)
      messages.push({
        ordinal: activity.ordinal,
        from: senderOf(activity),
        to: to.length === 0 ? LEAD_NAME : to,
        message,
        ...(summary === undefined ? {} : { summary }),
      })
    }
  }
  // A create whose result never came is still a task the model asked for.
  for (const created of pendingCreates.values()) upsert(created.id, created)
  return { members, tasks: [...board.values()], messages }
}

/** A member row's status word, from the task board's vocabulary. */
export function memberStatusKey(status: ClaudeTaskStatus): 'teamStatusRunning' | 'teamStatusCompleted' | 'teamStatusFailed' | 'teamStatusStopped' | 'teamStatusKilled' {
  switch (status) {
    case 'running': return 'teamStatusRunning'
    case 'completed': return 'teamStatusCompleted'
    case 'failed': return 'teamStatusFailed'
    case 'stopped': return 'teamStatusStopped'
    case 'killed': return 'teamStatusKilled'
  }
}

export function taskStatusKey(status: ClaudeTeamTaskStatus): 'teamTaskPending' | 'teamTaskInProgress' | 'teamTaskCompleted' {
  return status === 'pending' ? 'teamTaskPending' : status === 'in_progress' ? 'teamTaskInProgress' : 'teamTaskCompleted'
}
