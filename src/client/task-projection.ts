import type { ClaudeActivityEvent, ClaudeTaskInfo } from '../events.ts'

/** Tasks UI is reserved for detached work and genuine Claude subagents. */
export function isProjectedTask(task: ClaudeTaskInfo): boolean {
  if (task.backgrounded === true) return true
  return task.subagentType !== undefined && task.subagentType.trim().length > 0
}

export function isProjectedTaskActivity(
  activity: ClaudeActivityEvent,
  tasks: readonly ClaudeTaskInfo[],
): boolean {
  if (activity.kind !== 'subagent' || activity.parentToolUseId !== undefined) return true
  if (activity.taskId === undefined) return false
  const task = tasks.find(candidate => candidate.taskId === activity.taskId)
  return task !== undefined && isProjectedTask(task)
}
