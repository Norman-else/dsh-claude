import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ClaudeTaskLauncher } from './ClaudeActivityTail.tsx'
import type { ClaudeCodeSettingsKey } from './locales.ts'

export interface ClaudeActiveTasksNodeProps extends Omit<ChatNodeViewProps<'claude-active-tasks'>, 't'> {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  openTasks: (turn: number) => void
}

const EMPTY_TASKS = [] as const

/** Render the task launcher while the owning DSH turn is still open. */
export function ClaudeActiveTasksNode({ node, useClaudeProjection, t, openTasks }: ClaudeActiveTasksNodeProps) {
  const tasks = useClaudeProjection(value => value.tasks?.tasks ?? EMPTY_TASKS)
  return <ClaudeTaskLauncher turn={node.data.turn} tasks={tasks} t={t} openTasks={openTasks} />
}
