import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeDiffPanel, numberDiffLines, parseUnifiedDiff } from '../src/client/ClaudeDiffPanel.tsx'
import { ClaudeRepositoryStatus, PullRequestHoverCard, repositorySummary } from '../src/client/ClaudeRepositoryStatus.tsx'
import { clampDetailsWidth, defaultDetailsWidth } from '../src/client/details-resize.ts'
import type { ClaudeCodeSettingsKey } from '../src/client/locales.ts'
import type { ClaudeClientProjection } from '../src/client/projection.ts'

const repository = {
  status: 'ready' as const,
  cwd: '/repo',
  root: '/repo',
  branch: 'feature/status',
  detached: false,
  worktree: true,
  dirty: true,
  remote: 'Mercaso/premier-store-os',
  pullRequest: {
    number: 12,
    title: 'Repository status',
    url: 'https://github.com/Mercaso/premier-store-os/pull/12',
    state: 'open' as const,
    draft: false,
    review: 'approved' as const,
    checks: 'passing' as const,
    mergeState: 'CLEAN',
    author: 'norman-else',
    createdAt: '2026-08-21T13:00:00.000Z',
    baseBranch: 'master',
  },
  diff: {
    additions: 2,
    deletions: 1,
    files: 1,
    truncated: false,
    patch: 'diff --git a/src/file.ts b/src/file.ts\nindex 111..222 100644\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context\n',
  },
}

const projection: ClaudeClientProjection = {
  schemaVersion: 1,
  revision: 1,
  owned: true,
  commands: [],
  activities: [],
  repository,
}

const copy: Partial<Record<ClaudeCodeSettingsKey, string>> = {
  repositoryOpen: 'Show repository details',
  repositoryPanel: 'Repository status',
  repositoryClose: 'Close repository panel',
  repositorySection: 'Repository',
  repositoryStatus: 'Status',
  repositoryAvailable: 'Available',
  repositoryLocal: 'Local repository',
  repositoryCwd: 'Session directory',
  repositoryRoot: 'Repository root',
  repositoryBranch: 'Branch',
  repositoryWorktree: 'Worktree',
  repositoryWorktreeLabel: 'Git worktree',
  repositoryChanges: 'Changes',
  repositoryModified: 'Modified',
  repositoryClean: 'Clean',
  repositoryPullRequest: 'Pull request',
  repositoryPr: 'PR #{number}',
  repositoryPrState: 'PR state',
  repositoryState_open: 'Open',
  repositoryChecks: 'Checks',
  repositoryChecks_passing: 'Checks passing',
  repositoryReview: 'Review',
  repositoryReview_approved: 'Approved',
  repositoryMergeState: 'Merge state',
  repositoryOpenPr: 'Open on GitHub',
  yes: 'Yes',
  no: 'No',
  diffOpen: 'View working tree diff',
  diffClose: 'Close diff panel',
  diffWorkingTree: 'Working tree changes',
  diffFiles: '{count} modified file(s)',
  diffTruncated: 'Diff truncated',
  diffEmpty: 'No tracked changes',
  diffFilesShort: '{count} files',
}

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string => {
  let value = copy[key] ?? key
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}

function hook(value: ClaudeClientProjection) {
  return <T,>(selector: (projection: ClaudeClientProjection) => T): T => selector(value)
}

describe('Claude repository status UI', () => {
  it('allows Details to fill at most half of its frame', () => {
    expect(clampDetailsWidth(360, 1_600)).toBe(360)
    expect(clampDetailsWidth(900, 1_600)).toBe(800)
    expect(clampDetailsWidth(100, 1_600)).toBe(300)
    expect(clampDetailsWidth(400, 500)).toBe(300)
    expect(defaultDetailsWidth(1_600)).toBe(480)
    expect(defaultDetailsWidth(800)).toBe(400)
  })

  it('summarizes branch, worktree, changes, PR, checks, and review', () => {
    expect(repositorySummary(repository, t)).toEqual([
      'feature/status', 'Worktree', 'Modified', 'PR #12', 'Checks passing', 'Approved',
    ])
  })

  it('renders nothing outside Claude-owned sessions', () => {
    const markup = renderToStaticMarkup(<ClaudeRepositoryStatus
      useClaudeProjection={hook({ ...projection, owned: false })}
      t={t}
      openDiff={vi.fn()}
    />)
    expect(markup).toBe('')
  })

  it('renders a composer-width static bar with only a diff button', () => {
    const statusMarkup = renderToStaticMarkup(<ClaudeRepositoryStatus
      useClaudeProjection={hook(projection)}
      t={t}
      openDiff={vi.fn()}
    />)
    expect(statusMarkup).toContain('feature/status')
    expect(statusMarkup).toContain('#12')
    expect(statusMarkup).toContain('<svg')
    expect(statusMarkup).toContain('viewBox="0 0 16 16"')
    expect(statusMarkup).toContain('<circle cx="12" cy="13" r="1.6"></circle>')
    expect(statusMarkup).not.toContain('transform="translate(-2 0)"')
    expect(statusMarkup).not.toContain('⑂')
    expect(statusMarkup).toContain('+2')
    expect(statusMarkup).toContain('−1')
    expect(statusMarkup).toContain('width:calc(100% - 64px)')
    expect(statusMarkup).toContain('max-width:var(--dsh-conversation-composer-max-width, 782px)')
    expect(statusMarkup).toContain('premier-store-os')
    expect(statusMarkup).not.toContain('Mercaso/premier-store-os</span>')
    expect(statusMarkup).toContain('margin:0 auto')
    expect(statusMarkup).not.toContain('max-width:524px')
    expect(statusMarkup.match(/<button/g)).toHaveLength(1)
    expect(statusMarkup).toContain('aria-label="View working tree diff"')
    expect(statusMarkup).toContain('href="https://github.com/Mercaso/premier-store-os/pull/12"')
    expect(statusMarkup).toContain('target="_blank"')
    expect(statusMarkup).toContain('rel="noopener noreferrer"')
  })

  it('renders the Claude-style PR hover content', () => {
    const hoverMarkup = renderToStaticMarkup(<PullRequestHoverCard repository={repository} t={t} />)
    expect(hoverMarkup).toContain('role="tooltip"')
    expect(hoverMarkup).toContain('premier-store-os #12')
    expect(hoverMarkup).not.toContain('Mercaso/premier-store-os #12')
    expect(hoverMarkup).toContain('Repository status')
    expect(hoverMarkup).toContain('href="https://github.com/Mercaso/premier-store-os/pull/12"')
    expect(hoverMarkup).toContain('target="_blank"')
    expect(hoverMarkup).toContain('pointer-events:auto')
    expect(hoverMarkup).toContain('norman-else')
    expect(hoverMarkup).toContain('+2')
    expect(hoverMarkup).toContain('−1')
    expect(hoverMarkup).toContain('1 files')
  })

  it('parses and renders a file-grouped themed diff panel', () => {
    expect(numberDiffLines([
      '@@ -10,2 +10,2 @@', ' old', '-removed', '+added',
      '@@ -20,1 +20,1 @@', ' later',
    ])).toEqual([
      { line: '@@ -10,2 +10,2 @@', kind: 'hunk' },
      { line: ' old', kind: 'context', oldLine: 10, newLine: 10 },
      { line: '-removed', kind: 'delete', oldLine: 11 },
      { line: '+added', kind: 'add', newLine: 11 },
      { line: '8 unmodified lines', kind: 'collapsed' },
      { line: '@@ -20,1 +20,1 @@', kind: 'hunk' },
      { line: ' later', kind: 'context', oldLine: 20, newLine: 20 },
    ])
    expect(parseUnifiedDiff(repository.diff.patch)).toEqual([{
      path: 'src/file.ts',
      additions: 2,
      deletions: 1,
      lines: ['@@ -1,2 +1,3 @@', '-old', '+new', '+more', ' context', ''],
    }])
    const panelMarkup = renderToStaticMarkup(<ClaudeDiffPanel
      useClaudeProjection={hook(projection)}
      t={t}
      closeDetails={vi.fn()}
    />)
    expect(panelMarkup).toContain('Working tree changes')
    expect(panelMarkup).toContain('src/file.ts')
    expect(panelMarkup).toContain('+2')
    expect(panelMarkup).toContain('−1')
    expect(panelMarkup).toContain('aria-expanded="true"')
    expect(panelMarkup).toContain('width:calc(100% - 16px)')
    expect(panelMarkup).toContain('height:calc(100% - 16px)')
    expect(panelMarkup).toContain('margin:8px')
    expect(panelMarkup).toContain('height:49px')
    expect(panelMarkup).toContain('box-sizing:border-box')
    expect(panelMarkup).toContain('border-radius:12px')
    expect(panelMarkup).not.toContain('github.com/Mercaso/premier-store-os/pull/12')
  })
})
