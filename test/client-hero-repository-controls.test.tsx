import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconBranchOutline16: () => <svg data-icon="branch" />,
  IconCheckOutline14: () => <svg data-icon="check" />,
  IconChevronDownOutline14: () => <svg data-icon="chevron-down" />,
  IconSearchOutline16: () => <svg data-icon="search" />,
}))

import {
  branchMenuNavigationIndex,
  ClaudeHeroRepositoryCapsule,
  filterRepositoryBranches,
  repositoryBranchOptions,
  selectedBranchFirst,
  toggleTicketSelection,
  WorktreeProgressCard,
} from '../src/client/ClaudeHeroRepositoryControls.tsx'
import type { JiraTicket } from '../src/client/jira-api.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

describe('Claude hero repository capsule', () => {
  it('uses DSH menu and custom checkbox semantics without native form controls', () => {
    const markup = renderToStaticMarkup(<ClaudeHeroRepositoryCapsule
      branches={['main', 'feature/payments']}
      selected="feature/payments"
      worktree
      busy={false}
      menuOpen={false}
      worktreeLabel="Worktree"
      searchPlaceholder="Search branches"
      emptySearchLabel="No matching branches"
      onMenuOpenChange={vi.fn()}
      onSelect={vi.fn()}
      onWorktreeChange={vi.fn()}
    />)

    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('feature/payments')
    expect(markup).toContain('role="checkbox"')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('Worktree')
    expect(markup).toContain('width:15px')
    expect(markup).toContain('background:var(--dsw-static-blue-450)')
    expect(markup).toContain('viewBox="0 0 12 12"')
    expect(markup).not.toContain('<select')
    expect(markup).not.toContain('<input')
    expect(markup).not.toContain('>Branch<')
    expect(markup).not.toContain('>分支<')
  })

  it('renders a searchable menu with a five-row scrolling limit', () => {
    const markup = renderToStaticMarkup(<ClaudeHeroRepositoryCapsule
      branches={['main', 'feature/a', 'feature/b', 'feature/c', 'feature/d', 'feature/e']}
      selected="main"
      worktree={false}
      busy={false}
      menuOpen
      worktreeLabel="Worktree"
      searchPlaceholder="Search branches"
      emptySearchLabel="No matching branches"
      onMenuOpenChange={vi.fn()}
      onSelect={vi.fn()}
      onWorktreeChange={vi.fn()}
    />)

    expect(markup).toContain('type="search"')
    expect(markup).toContain('aria-label="Search branches"')
    expect(markup).toContain('max-height:170px')
    expect(markup).toContain('overflow-y:auto')
  })

  it('always combines local and remote-tracking branches with local precedence', () => {
    expect(repositoryBranchOptions({
      root: '/repo', current: 'main', dirty: false,
      branches: ['main', 'origin/local-name'],
      remoteBranches: ['origin/feature/a', 'origin/local-name'],
    })).toEqual(['main', 'origin/local-name', 'origin/feature/a'])
  })

  it('puts the selected branch first and supports wrapping keyboard navigation', () => {
    expect(selectedBranchFirst(['feature/a', 'main', 'origin/main'], 'main')).toEqual(['main', 'feature/a', 'origin/main'])
    expect(branchMenuNavigationIndex(0, 3, 'ArrowDown')).toBe(1)
    expect(branchMenuNavigationIndex(0, 3, 'ArrowUp')).toBe(2)
    expect(branchMenuNavigationIndex(1, 3, 'Home')).toBe(0)
    expect(branchMenuNavigationIndex(1, 3, 'End')).toBe(2)
  })

  it('renders staged Worktree progress independently from the branch controls', () => {
    const t = (key: ClaudeCodeSettingsKey): string => en[key]
    const markup = renderToStaticMarkup(<WorktreeProgressCard
      stage="creating-workspace"
      t={t}
      onDismiss={vi.fn()}
    />)

    expect(markup).toContain('role="status"')
    expect(markup).toContain('Creating Worktree')
    expect(markup).toContain('Creating DSH Workspace')
    expect(markup).toContain('Checking repository and branch')
    expect(markup).toContain('Saving Worktree state')
    expect(markup).not.toContain('Dismiss Worktree progress')
    expect(markup).not.toContain('Preparing repository')
  })

  it('renders a persistent dismissible Worktree failure', () => {
    const t = (key: ClaudeCodeSettingsKey): string => en[key]
    const markup = renderToStaticMarkup(<WorktreeProgressCard
      stage="fetching"
      error="Git could not refresh remote references."
      t={t}
      onDismiss={vi.fn()}
    />)

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Worktree creation failed')
    expect(markup).toContain('Git could not refresh remote references.')
    expect(markup).toContain('aria-label="Dismiss Worktree progress"')
  })

  it('toggles ticket selection by key and preserves order', () => {
    const first: JiraTicket = { key: 'PSOS-1', summary: 'One', url: 'https://x/browse/PSOS-1' }
    const second: JiraTicket = { key: 'PSOS-2', summary: 'Two', url: 'https://x/browse/PSOS-2' }
    const one = toggleTicketSelection([], first)
    const two = toggleTicketSelection(one, second)
    expect(two.map(ticket => ticket.key)).toEqual(['PSOS-1', 'PSOS-2'])
    expect(toggleTicketSelection(two, first).map(ticket => ticket.key)).toEqual(['PSOS-2'])
  })

  it('locks the Worktree toggle checked during a multi-ticket kickoff', () => {
    const markup = renderToStaticMarkup(<ClaudeHeroRepositoryCapsule
      branches={['main']}
      selected="main"
      worktree={false}
      busy={false}
      menuOpen={false}
      worktreeLabel="Worktree"
      searchPlaceholder="Search branches"
      emptySearchLabel="No matching branches"
      worktreeLocked
      onMenuOpenChange={vi.fn()}
      onSelect={vi.fn()}
      onWorktreeChange={vi.fn()}
    />)
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toMatch(/role="checkbox"[^>]*disabled/)
  })

  it('annotates batch progress with the active ticket', () => {
    const t = (key: ClaudeCodeSettingsKey): string => en[key]
    const markup = renderToStaticMarkup(<WorktreeProgressCard
      stage="creating-worktree"
      context="PSOS-1 · 1/3"
      t={t}
      onDismiss={vi.fn()}
    />)
    expect(markup).toContain('PSOS-1 · 1/3')
  })

  it('filters branches case-insensitively with trimmed input', () => {
    expect(filterRepositoryBranches(
      ['main', 'feature/Payments', 'fix/payments-timeout'],
      ' PAYMENTS ',
    )).toEqual(['feature/Payments', 'fix/payments-timeout'])
    expect(filterRepositoryBranches(['main'], 'missing')).toEqual([])
  })
})
