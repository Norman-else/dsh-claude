import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ClaudeTurnFooter } from './ClaudeActivityTail.tsx'
import type { ClaudeCodeSettingsKey } from './locales.ts'

export interface ClaudeActiveTasksNodeProps extends Omit<ChatNodeViewProps<'claude-active-tasks'>, 't'> {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  openTasks: (turn: number) => void
}

/** Render the turn footer while the owning DSH turn is still open. */
export function ClaudeActiveTasksNode({ node, useClaudeProjection, t, openTasks }: ClaudeActiveTasksNodeProps) {
  return <ClaudeTurnFooter turn={node.data.turn} useClaudeProjection={useClaudeProjection} t={t} openTasks={openTasks} />
}
