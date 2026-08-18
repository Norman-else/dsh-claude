import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { claudeActivityDefinition } from '../src/client/conversation.ts'
import { ClaudeActivity } from '../src/client/ClaudeActivity.tsx'

function event(data: ClaudeActivityEvent) {
  return { type: 'claude-code/activity', data, seq: data.ordinal, time: data.ordinal } as never
}

function match(data: ClaudeActivityEvent, role: 'start' | 'update'): ConversationMatch {
  return {
    event: event(data),
    view: undefined,
    role,
    location: { kind: 'unresolved' },
  }
}

const first: ClaudeActivityEvent = {
  turn: 1,
  step: 1,
  ordinal: 0,
  kind: 'status',
  phase: 'started',
  title: 'Claude Code turn started',
}

const second: ClaudeActivityEvent = {
  turn: 1,
  step: 1,
  ordinal: 1,
  kind: 'tool-call',
  phase: 'started',
  toolName: 'Read',
  title: 'Read',
  summary: 'Claude called Read',
  detail: '{"file_path":"README.md"}',
}

describe('Claude conversation projection', () => {
  it('starts on ordinal zero and accumulates ordered activity', () => {
    expect(claudeActivityDefinition.match(event(first))).toEqual({ id: 'turn-1', role: 'start' })
    expect(claudeActivityDefinition.match({ type: 'turn/start' } as never)).toBeNull()
    const initial = claudeActivityDefinition.start({} as never, match(first, 'start'), {} as never)
    const context = { state: initial } as ConversationNodeContext<typeof initial> & { state: typeof initial }
    const updated = claudeActivityDefinition.update(context, match(second, 'update'))
    expect(updated.activities).toEqual([first, second])
    const data = claudeActivityDefinition.buildLocationData?.({ state: updated } as never, 'turn')
    expect(data).toMatchObject({ kind: 'turn', turn: 1, key: 'claudeCode' })
  })

  it('renders a compact native turn-tail activity rail', () => {
    const t = (key: string) => ({ activity: 'Claude Code activity', detail: 'Show redacted detail' })[key] ?? key
    const html = renderToStaticMarkup(
      <ClaudeActivity matched={{ turn: 1, activities: [first, second] }} t={t as never} />,
    )
    expect(html).toContain('Claude Code activity')
    expect(html).toContain('Claude called Read')
    expect(html).toContain('README.md')
    expect(html).not.toContain('tool-call-delta')
  })
})
