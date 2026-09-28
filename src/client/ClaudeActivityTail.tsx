import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ClaudeTurnUsage } from './ClaudeActivityNode.tsx'
import { latestTurnUsage, selectClaudeTurn } from './conversation-sidecar.ts'

export interface ClaudeActivityTailInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

export interface ClaudeActivityTailProps extends ClaudeActivityTailInjected, Pick<TurnTailOwnerProps, 'turn'> {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

/** What the turn cost, once it is over. Background work is the Host's own
 *  session-header job list (see host-jobs.ts), not a launcher here. */
export function ClaudeActivityTail({ turn, useClaudeProjection, t }: ClaudeActivityTailProps) {
  const matched = selectClaudeTurn({ turn })
  const usage = useClaudeProjection(value => matched === null ? undefined : latestTurnUsage(value.activities, matched.turn))
  if (matched === null || usage === undefined) return null
  return <ClaudeTurnUsage usage={usage} t={t} />
}
