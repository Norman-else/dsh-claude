import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ClaudePullRequestsPanel,
  claudeSessionRows,
  overviewAttention,
  type OverviewProjectionSource,
  type OverviewSessionRow,
} from '../src/client/ClaudePullRequestsPanel.tsx'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { EMPTY_CLAUDE_PROJECTION } from '../src/client/projection.ts'

const byId: Record<string, OverviewSessionRow> = {
  a: { id: 'a', displayTitle: 'Login fix', cwd: '/repo-a', agentPreset: 'claude', running: false },
  b: { id: 'b', displayTitle: 'Dark mode', cwd: '/repo-b', agentPreset: 'claude', running: true },
  c: { id: 'c', displayTitle: 'Native', cwd: '/repo-c', agentPreset: 'deepseek' },
  d: { id: 'd', displayTitle: 'Blank', cwd: '/repo-d', agentPreset: 'claude', blank: true },
}

const t = ((key: string) => key) as never

function store(rows: Record<string, OverviewSessionRow>) {
  return { subscribe: () => () => {}, getSnapshot: () => ({ ids: Object.keys(rows), byId: rows }) }
}

describe('Claude pull requests overview', () => {
  it('lists only non-blank Claude sessions with running ones first', () => {
    expect(claudeSessionRows({ ids: Object.keys(byId), byId }).map(row => row.id)).toEqual(['b', 'a'])
  })

  it('drops sessions that left the host list even when byId still carries them', () => {
    // Deleting a session removes it from ids; its byId row can linger.
    expect(claudeSessionRows({ ids: ['a'], byId }).map(row => row.id)).toEqual(['a'])
    expect(claudeSessionRows({
      ids: ['a', 'e'],
      byId: { ...byId, e: { id: 'e', displayTitle: 'Sub', cwd: '/repo-e', agentPreset: 'claude', origin: 'subagent' } },
    }).map(row => row.id)).toEqual(['a'])
    // No ids feed (test fixtures): fall back to every row.
    expect(claudeSessionRows({ byId }).map(row => row.id)).toEqual(['b', 'a'])
  })

  it('hides archived sessions: DSH "delete" archives while the host list keeps the row', () => {
    expect(claudeSessionRows({ ids: Object.keys(byId), byId }, ['b']).map(row => row.id)).toEqual(['a'])
  })

  it('reads the preset from the projection column when the summary field is unset', () => {
    // Desktop 2.0.4 serves every row with `agentPreset` unset and publishes the
    // composed preset through `projectionValues` instead; reading only the
    // summary field emptied the whole board.
    const projected: Record<string, OverviewSessionRow> = {
      p: { id: 'p', displayTitle: 'Projected', cwd: '/repo-p', projectionValues: { agentPreset: 'claude' } },
      q: { id: 'q', displayTitle: 'Other agent', cwd: '/repo-q', projectionValues: { agentPreset: 'standard' } },
    }

    expect(claudeSessionRows({ ids: Object.keys(projected), byId: projected }).map(row => row.id)).toEqual(['p'])
  })

  it('prefers the summary field over the projection column', () => {
    const both: Record<string, OverviewSessionRow> = {
      r: { id: 'r', displayTitle: 'Switched', cwd: '/repo-r', agentPreset: 'standard', projectionValues: { agentPreset: 'claude' } },
    }

    expect(claudeSessionRows({ ids: ['r'], byId: both })).toEqual([])
  })

  it('renders session rows and an empty state', () => {
    const markup = renderToStaticMarkup(<ClaudePullRequestsPanel t={t} closeDetails={vi.fn()} openSession={vi.fn()} loadStatus={vi.fn()} sessions={store(byId)} />)
    expect(markup).toContain('overviewTitle')
    // Details cards must clear the DSH Desktop macOS caption row that overlaps the column top.
    expect(markup).toContain('class="dshClaudeDetailsCard"')
    expect(markup).toContain('.dshDesktopDetailsSurface .dshClaudeDetailsCard {\n  height: calc(100% - 28px);\n  margin-top: 20px;')
    expect(markup).toContain('Dark mode')
    expect(markup).toContain('Login fix')
    expect(markup).not.toContain('Native')
    expect(markup).toContain('aria-label="overviewRunning"')
    expect(markup).toContain('overviewLoading')
    const empty = renderToStaticMarkup(<ClaudePullRequestsPanel t={t} closeDetails={vi.fn()} openSession={vi.fn()} loadStatus={vi.fn()} sessions={store({})} />)
    expect(empty).toContain('overviewEmpty')
  })

  it('derives what a session is blocked on from the latest prompt activity', () => {
    const base = { turn: 1, step: 1 }
    const pending: ClaudeActivityEvent[] = [
      { ...base, ordinal: 0, kind: 'tool-call', phase: 'completed' },
      { ...base, ordinal: 1, kind: 'permission', phase: 'started' },
    ]
    expect(overviewAttention(pending)).toBe('permission')
    expect(overviewAttention([...pending, { ...base, ordinal: 1, kind: 'permission', phase: 'completed' }])).toBeUndefined()
    expect(overviewAttention([...pending, { ...base, ordinal: 2, kind: 'question', phase: 'started' }])).toBe('question')
    expect(overviewAttention([])).toBeUndefined()
  })

  it('shows attention badges and context usage from the session projection', () => {
    const projection = {
      ...EMPTY_CLAUDE_PROJECTION,
      activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'permission' as const, phase: 'started' as const }],
      contextUsage: { model: 'claude', totalTokens: 50, maxTokens: 100, percentage: 50, categories: [] },
    }
    const projectionFor = (): OverviewProjectionSource => ({ subscribe: () => () => {}, getSnapshot: () => projection })
    const markup = renderToStaticMarkup(<ClaudePullRequestsPanel
      t={t}
      closeDetails={vi.fn()}
      openSession={vi.fn()}
      loadStatus={vi.fn()}
      sessions={store(byId)}
      projectionFor={projectionFor}
    />)
    // Only the running session (b) surfaces the pending permission badge.
    expect(markup.split('overviewNeedsPermission')).toHaveLength(2)
    expect(markup).toContain('overviewContextUsage')
  })
})
