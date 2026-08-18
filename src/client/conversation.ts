import type {
  ConversationLocationData,
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ClaudeActivityEvent } from '../events.ts'
import { CLAUDE_ACTIVITY_EVENT } from '../constants.ts'

export interface ClaudeTurnData {
  turn: number
  activities: readonly ClaudeActivityEvent[]
}

interface ClaudeActivityState {
  turn: number
  activities: readonly ClaudeActivityEvent[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    claudeCode: ClaudeTurnData
  }
}

function activity(match: ConversationMatch): ClaudeActivityEvent {
  return match.event.data as ClaudeActivityEvent
}

function ordered(items: readonly ClaudeActivityEvent[]): ClaudeActivityEvent[] {
  return [...items]
    .sort((left, right) => left.ordinal - right.ordinal)
    .filter((item, index, all) => index === 0 || item.ordinal !== all[index - 1]?.ordinal)
}

export const claudeActivityDefinition: ConversationNodeDefinition<ClaudeActivityState> = {
  kind: 'claude-code-activity',
  match(event: SessionEvent) {
    if (event.type !== CLAUDE_ACTIVITY_EVENT) return null
    const value = event.data as ClaudeActivityEvent
    return {
      id: `turn-${value.turn}`,
      role: value.ordinal === 0 ? 'start' : 'update',
    }
  },
  start(_context, match) {
    const value = activity(match)
    return { turn: value.turn, activities: [value] }
  },
  update(context, match) {
    const value = activity(match)
    if (value.turn !== context.state.turn) return context.state
    return {
      turn: context.state.turn,
      activities: ordered([...context.state.activities, value]),
    }
  },
  publication() {
    return 'animation-frame'
  },
  buildLocationData(context: ConversationNodeContext<ClaudeActivityState>, scope): ConversationLocationData | null {
    if (scope !== 'turn' || context.state === undefined) return null
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'claudeCode',
      value: {
        turn: context.state.turn,
        activities: context.state.activities,
      },
    }
  },
}
