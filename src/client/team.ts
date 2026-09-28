/**
 * Claude Code's native Agent Team, read off what the sidecar already holds.
 *
 * A teammate is an `Agent` call that carries a `name` (the CLI's own team
 * model: the session is one implicit team and a named agent is addressable
 * through SendMessage). Over the SDK the CLI never initializes a session
 * team, so such an agent runs as a `local_agent` task rather than an
 * `in_process_teammate`; both count. The shared task list comes through the
 * TaskCreate / TaskUpdate tools and mail through SendMessage. The task board
 * carries the spawning call id and the activity log every call's input, so
 * roster, board, and mailbox are derived here without a server-side projection.
 */
import type { ClaudeActivityEvent, ClaudeTaskInfo, ClaudeTaskStatus, ClaudeTaskUsage } from '../events.ts'

export const TEAMMATE_TASK_TYPE = 'in_process_teammate'
export const SUBAGENT_TASK_TYPE = 'local_agent'
export const LEAD_NAME = 'lead'

export interface ClaudeTeamMember {
  taskId: string
  name: string
  role: 'lead' | 'teammate'
  status: ClaudeTaskStatus
  description: string
  /** The Agent call that spawned the teammate; its nested calls carry it as parent. */
  toolUseId?: string
  /** What the Lead asked it to do, from the spawning call. */
  prompt?: string
  /** What it reported back when it settled. */
  summary?: string
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
  const ordered = [...activities].sort((left, right) => left.ordinal - right.ordinal)
  const spawnInputs = new Map<string, Record<string, unknown>>()
  for (const activity of ordered) {
    if (activity.toolUseId !== undefined && activity.toolName !== undefined && activity.phase === 'started') {
      const input = parseRecord(activity.detail)
      if (input !== undefined) spawnInputs.set(activity.toolUseId, input)
    }
  }
  const spawnName = (task: ClaudeTaskInfo): string | undefined =>
    task.toolUseId === undefined ? undefined : text(spawnInputs.get(task.toolUseId)?.name)
  const teammates = tasks.filter(task =>
    task.taskType === TEAMMATE_TASK_TYPE || (task.taskType === SUBAGENT_TASK_TYPE && spawnName(task) !== undefined))
  if (teammates.length === 0 && !ordered.some(activity => activity.toolName === 'TaskCreate' || activity.toolName === 'SendMessage')) {
    return EMPTY_TEAM
  }
  const members: ClaudeTeamMember[] = teammates.map(task => {
    const spawn = task.toolUseId === undefined ? undefined : spawnInputs.get(task.toolUseId)
    const prompt = text(spawn?.prompt)
    return {
      taskId: task.taskId,
      name: text(spawn?.name) ?? task.description,
      role: 'teammate',
      status: task.status,
      description: text(spawn?.description) ?? task.description,
      ...(task.toolUseId === undefined ? {} : { toolUseId: task.toolUseId }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(task.summary === undefined ? {} : { summary: task.summary }),
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
