import type { CSSProperties } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { sessionTokensPerSecond } from './conversation-sidecar.ts'

export interface ClaudeSessionSpeedInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

export interface ClaudeSessionSpeedProps extends ClaudeSessionSpeedInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

const STYLE: CSSProperties = {
  alignSelf: 'center',
  padding: '0 6px',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--dsw-alias-label-caption)',
  whiteSpace: 'nowrap',
}

/** The session's model output speed in the composer row. Read off the turn
 *  usage records, so it survives reloads with the transcript itself. */
export function ClaudeSessionSpeed({ t, useClaudeProjection }: ClaudeSessionSpeedProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const rate = useClaudeProjection(projection => sessionTokensPerSecond(projection.activities))
  if (!owned || rate === undefined) return null
  return (
    <Tooltip label={t('sessionOutputSpeed')} side="top" delayMs={250}>
      <span style={STYLE} data-dsh-claude-session-speed="">{t('turnUsageSpeed', { rate: Math.round(rate) })}</span>
    </Tooltip>
  )
}
