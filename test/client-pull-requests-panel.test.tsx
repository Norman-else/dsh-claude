import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClaudePullRequestsPanel, claudeSessionRows, type OverviewSessionRow } from '../src/client/ClaudePullRequestsPanel.tsx'

const byId: Record<string, OverviewSessionRow> = {
  a: { id: 'a', displayTitle: 'Login fix', cwd: '/repo-a', agentPreset: 'claude', running: false },
  b: { id: 'b', displayTitle: 'Dark mode', cwd: '/repo-b', agentPreset: 'claude', running: true },
  c: { id: 'c', displayTitle: 'Native', cwd: '/repo-c', agentPreset: 'deepseek' },
  d: { id: 'd', displayTitle: 'Blank', cwd: '/repo-d', agentPreset: 'claude', blank: true },
}

const t = ((key: string) => key) as never

function store(rows: Record<string, OverviewSessionRow>) {
  return { subscribe: () => () => {}, getSnapshot: () => ({ byId: rows }) }
}

describe('Claude pull requests overview', () => {
  it('lists only non-blank Claude sessions with running ones first', () => {
    expect(claudeSessionRows(byId).map(row => row.id)).toEqual(['b', 'a'])
  })

  it('renders session rows and an empty state', () => {
    const markup = renderToStaticMarkup(<ClaudePullRequestsPanel t={t} closeDetails={vi.fn()} openSession={vi.fn()} loadStatus={vi.fn()} sessions={store(byId)} />)
    expect(markup).toContain('overviewTitle')
    expect(markup).toContain('Dark mode')
    expect(markup).toContain('Login fix')
    expect(markup).not.toContain('Native')
    expect(markup).toContain('aria-label="overviewRunning"')
    expect(markup).toContain('overviewLoading')
    const empty = renderToStaticMarkup(<ClaudePullRequestsPanel t={t} closeDetails={vi.fn()} openSession={vi.fn()} loadStatus={vi.fn()} sessions={store({})} />)
    expect(empty).toContain('overviewEmpty')
  })
})
