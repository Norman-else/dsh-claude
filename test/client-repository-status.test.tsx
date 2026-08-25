import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeDiffPanel, actionLabel, numberDiffLines, parseUnifiedDiff, repositoryActionAvailability } from '../src/client/ClaudeDiffPanel.tsx'
import { ClaudeRepositoryStatus, PullRequestHoverCard, rateLimitBlocked, repositorySummary } from '../src/client/ClaudeRepositoryStatus.tsx'
import { clampDetailsWidth, defaultDetailsWidth } from '../src/client/details-resize.ts'
import type { ClaudeCodeSettingsKey } from '../src/client/locales.ts'
import type { ClaudeClientProjection } from '../src/client/projection.ts'
import * as styles from '../src/client/styles.ts'

const repository = {
  status: 'ready' as const,
  cwd: '/repo',
  root: '/repo',
  branch: 'feature/status',
  detached: false,
  worktree: true,
  dirty: true,
  upstream: true,
  ahead: 0,
  behind: 0,
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
  repositoryState_merged: 'Merged',
  repositoryMergedInto: 'Merged into {branch}',
  repositoryMergedAgo: '{age} ago',
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

function sessionsHook(blank: boolean) {
  return <T,>(selector: (sessions: { readonly byId: Readonly<Record<string, { readonly blank: boolean } | undefined>> }) => T): T => selector({
    byId: { session: { blank } },
  })
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
      sessionId="session"
      useSessions={sessionsHook(false)}
      useClaudeProjection={hook({ ...projection, owned: false })}
      t={t}
      openDiff={vi.fn()}
    />)
    expect(markup).toBe('')
  })

  it('suppresses the repository bar on blank sessions', () => {
    const markup = renderToStaticMarkup(<ClaudeRepositoryStatus
      sessionId="session"
      useSessions={sessionsHook(true)}
      useClaudeProjection={hook(projection)}
      t={t}
      openDiff={vi.fn()}
    />)
    expect(markup).toBe('')
  })

  it('renders a composer-width static bar with only a diff button', () => {
    const statusMarkup = renderToStaticMarkup(<ClaudeRepositoryStatus
      sessionId="session"
      useSessions={sessionsHook(false)}
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

  it('surfaces a quota badge while the newest rate limit update is blocking', () => {
    expect(rateLimitBlocked([])).toBe(false)
    expect(rateLimitBlocked([{ title: 'Claude rate limit is blocking requests' }])).toBe(true)
    expect(rateLimitBlocked([
      { title: 'Claude rate limit is blocking requests' },
      { title: 'Claude rate limit status changed' },
    ])).toBe(false)
    expect(rateLimitBlocked([
      { title: 'Claude rate limit status changed' },
      { title: 'Claude API retry' },
      { title: 'Claude rate limit is blocking requests' },
    ])).toBe(true)
    const markup = renderToStaticMarkup(<ClaudeRepositoryStatus
      sessionId="session"
      useSessions={sessionsHook(false)}
      useClaudeProjection={hook({
        ...projection,
        activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'status', title: 'Claude rate limit is blocking requests' } as never],
      })}
      t={t}
      openDiff={vi.fn()}
    />)
    expect(markup).toContain('repositoryRateLimited')
  })

  it('keeps the diff entry visible while commits are waiting to be pushed', () => {
    const render = (overrides: Partial<typeof repository>): string => renderToStaticMarkup(<ClaudeRepositoryStatus
      sessionId="session"
      useSessions={sessionsHook(false)}
      useClaudeProjection={hook({ ...projection, repository: { ...repository, ...overrides } })}
      t={t}
      openDiff={vi.fn()}
    />)
    const committed = render({ dirty: false, ahead: 2, diff: { additions: 0, deletions: 0, files: 0, truncated: false } })
    expect(committed).toContain('↑2')
    expect(committed).toContain('aria-label="View working tree diff"')
    expect(committed).not.toContain('+0')
    const pushed = render({ dirty: false, ahead: 0, diff: { additions: 0, deletions: 0, files: 0, truncated: false } })
    expect(pushed).not.toContain('↑')
    expect(pushed).not.toContain('aria-label="View working tree diff"')
    const dirtyAndAhead = render({ ahead: 2 })
    expect(dirtyAndAhead).toContain('+2')
    expect(dirtyAndAhead).toContain('↑2')
  })

  it('renders a merged PR as a purple terminal state instead of active checks', () => {
    const mergedRepository = {
      ...repository,
      pullRequest: {
        ...repository.pullRequest,
        state: 'merged' as const,
        mergedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
    }
    expect(repositorySummary(mergedRepository, t)).toEqual([
      'feature/status', 'Worktree', 'Modified', 'PR #12', 'Merged into master',
    ])
    const statusMarkup = renderToStaticMarkup(<ClaudeRepositoryStatus
      sessionId="session"
      useSessions={sessionsHook(false)}
      useClaudeProjection={hook({ ...projection, repository: mergedRepository })}
      t={t}
      openDiff={vi.fn()}
    />)
    expect(statusMarkup).toContain('Merged into master')
    expect(statusMarkup).toContain('2h ago')
    expect(statusMarkup).toContain('#a78bfa')
    expect(statusMarkup).toContain('color-mix(in srgb, #a78bfa 30%')
    expect(statusMarkup).not.toContain('Checks passing')
    expect(statusMarkup).not.toContain('Approved')
    expect(statusMarkup).toContain('<circle cx="12" cy="8" r="1.6"></circle>')

    const hoverMarkup = renderToStaticMarkup(<PullRequestHoverCard repository={mergedRepository} t={t} />)
    expect(hoverMarkup).toContain('Merged')
    expect(hoverMarkup).toContain('color-mix(in srgb, #a78bfa 18%')
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
      sessionId="session"
      maximized={false}
      closeDetails={vi.fn()}
      toggleMaximized={vi.fn()}
    />)
    expect(panelMarkup).toContain('Working tree changes')
    expect(panelMarkup).toContain('Commit')
    expect(panelMarkup).toContain('aria-label="diffCommitMenu"')
    expect(panelMarkup).toContain('aria-label="diffMaximize"')
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

  it('strips the menu ellipsis from dialog titles', () => {
    const copyT = ((key: string) => ({ diffCommitPush: 'Commit & Push…', diffCreatePr: 'Create PR…', diffCommit: 'Commit', diffPush: 'Push' }[key] ?? key)) as never
    expect(actionLabel('commit-push', copyT)).toBe('Commit & Push')
    expect(actionLabel('create-pr', copyT)).toBe('Create PR')
    expect(actionLabel('commit', copyT)).toBe('Commit')
    expect(actionLabel('push', copyT)).toBe('Push')
  })

  it('gates commit actions on the session repository state', () => {
    expect(repositoryActionAvailability(repository)).toEqual({
      'commit': true,
      'commit-push': true,
      'push': false,
      'create-pr': false,
    })
    expect(repositoryActionAvailability({
      ...repository,
      pullRequest: { ...repository.pullRequest, state: 'merged' as const },
    })).toEqual({ 'commit': true, 'commit-push': true, 'push': false, 'create-pr': true })
    const { pullRequest: _pullRequest, remote: _remote, ...localOnly } = repository
    expect(repositoryActionAvailability(localOnly)).toEqual({
      'commit': true,
      'commit-push': false,
      'push': false,
      'create-pr': false,
    })
    const none = { 'commit': false, 'commit-push': false, 'push': false, 'create-pr': false }
    expect(repositoryActionAvailability({ ...repository, dirty: false })).toEqual(none)
    expect(repositoryActionAvailability({ ...repository, detached: true })).toEqual(none)
    expect(repositoryActionAvailability(undefined)).toEqual(none)
  })

  it('enables Push for unpushed commits even with a clean working tree', () => {
    const committed = { ...repository, dirty: false, pullRequest: { ...repository.pullRequest, state: 'merged' as const } }
    expect(repositoryActionAvailability({ ...committed, ahead: 2 })).toEqual({
      'commit': false,
      'commit-push': false,
      'push': true,
      'create-pr': true,
    })
    const { ahead: _ahead, ...neverPushed } = { ...committed, upstream: false }
    expect(repositoryActionAvailability(neverPushed)).toMatchObject({
      'push': true,
      'create-pr': true,
    })
    expect(repositoryActionAvailability({ ...repository, ahead: 2 })).toMatchObject({ 'push': true, 'create-pr': false })
  })

  it('disables the Commit button when the working tree has nothing to commit', () => {
    const renderPanel = (dirty: boolean): string => renderToStaticMarkup(<ClaudeDiffPanel
      useClaudeProjection={hook({ ...projection, repository: { ...repository, dirty } })}
      t={t}
      sessionId="session"
      maximized={false}
      closeDetails={vi.fn()}
      toggleMaximized={vi.fn()}
    />)
    const cleanMarkup = renderPanel(false)
    expect(cleanMarkup).toMatch(/<button[^>]*disabled[^>]*>diffCommit<\/button>/u)
    expect(cleanMarkup).toMatch(/<button[^>]*disabled[^>]*aria-label="diffCommitMenu"/u)
    const dirtyMarkup = renderPanel(true)
    expect(dirtyMarkup).not.toMatch(/<button[^>]*disabled[^>]*>diffCommit<\/button>/u)
    expect(dirtyMarkup).not.toMatch(/<button[^>]*disabled[^>]*aria-label="diffCommitMenu"/u)
  })

  it('renders matching interactive icon buttons for maximize and close', () => {
    const markup = renderToStaticMarkup(<ClaudeDiffPanel
      useClaudeProjection={hook(projection)}
      t={t}
      sessionId="session"
      maximized={false}
      closeDetails={vi.fn()}
      toggleMaximized={vi.fn()}
    />)
    expect(markup).toMatch(/class="dshClaudePanelIconButton" aria-label="diffMaximize"[^>]*><svg\b/u)
    expect(markup).toMatch(/class="dshClaudePanelIconButton" aria-label="Close diff panel"[^>]*><svg\b/u)
    expect(markup).not.toContain('>×</button>')
    expect(styles.panelIconButtonCss).toContain('width: 26px')
    expect(styles.panelIconButtonCss).toContain('height: 26px')
    expect(styles.panelIconButtonCss).toContain(':hover')
    expect(styles.panelIconButtonCss).toContain(':active')
    expect(styles.panelIconButtonCss).toContain(':focus-visible')
  })

  it('renders the Commit menu trigger with a vector chevron', () => {
    const markup = renderToStaticMarkup(<ClaudeDiffPanel
      useClaudeProjection={hook(projection)}
      t={t}
      sessionId="session"
      maximized={false}
      closeDetails={vi.fn()}
      toggleMaximized={vi.fn()}
    />)

    expect(markup).toMatch(/aria-label="diffCommitMenu"[^>]*><svg\b/u)
    expect(markup).not.toMatch(/aria-label="diffCommitMenu"[^>]*>⌄<\/button>/u)
  })

  it('renders maximize and restore actions with vector window icons', () => {
    const renderPanel = (maximized: boolean): string => renderToStaticMarkup(<ClaudeDiffPanel
      useClaudeProjection={hook(projection)}
      t={t}
      sessionId="session"
      maximized={maximized}
      closeDetails={vi.fn()}
      toggleMaximized={vi.fn()}
    />)

    const maximizable = renderPanel(false)
    expect(maximizable).toMatch(/aria-label="diffMaximize"[^>]*><svg\b/u)
    expect(maximizable).not.toMatch(/aria-label="diffMaximize"[^>]*>↗<\/button>/u)

    const restorable = renderPanel(true)
    expect(restorable).toMatch(/aria-label="diffRestore"[^>]*><svg\b/u)
    expect(restorable).not.toMatch(/aria-label="diffRestore"[^>]*>↙<\/button>/u)
  })

  it('keeps the repository action form within the DSH modal content column', () => {
    expect(styles.diffModalBody).toMatchObject({
      width: '100%',
      minWidth: 0,
      boxSizing: 'border-box',
    })
    expect(styles.diffModalMetaText).toMatchObject({
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    })
    expect(styles.diffModalFile).toMatchObject({ minWidth: 0 })
    expect(styles.diffModalFilePath).toMatchObject({
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    })
    expect(styles.diffModalFileState).toMatchObject({ flex: 'none' })
  })

  it('doubles the repository action modal and uses readable form text', () => {
    const modalCss = Reflect.get(styles, 'diffModalCss') as string | undefined
    const modalButton = Reflect.get(styles, 'diffModalButton') as Record<string, unknown> | undefined
    const markup = renderToStaticMarkup(<ClaudeDiffPanel
      useClaudeProjection={hook(projection)}
      t={t}
      sessionId="session"
      maximized={false}
      closeDetails={vi.fn()}
      toggleMaximized={vi.fn()}
    />)

    expect(markup).toContain('data-dsh-claude-repository-modal-styles="true"')
    expect(modalCss).toContain('width: min(760px, calc(100vw - 48px))')
    expect(modalCss).toContain('max-height: min(680px, calc(100vh - 48px))')
    expect(modalCss).not.toMatch(/[^-]height: min\(680px/u)
    expect(modalCss).toContain('box-sizing: border-box')
    expect(modalCss).toContain('overflow-y: auto')
    expect(modalCss).toMatch(/> div:first-child \{\s*position: sticky;\s*top: 0;/u)
    expect(modalCss).toContain('font-size: 24px')
    expect(modalCss).toContain('font-size: 18px')
    expect(styles.diffModalMeta).toMatchObject({ fontSize: 16, lineHeight: '24px' })
    expect(styles.diffModalFile).toMatchObject({ fontSize: 15, lineHeight: '22px' })
    expect(styles.diffModalField).toMatchObject({ fontSize: 16, lineHeight: '24px' })
    expect(styles.diffModalCheckbox).toMatchObject({ fontSize: 16, lineHeight: '24px' })
    expect(styles.diffModalTextarea).toMatchObject({ minHeight: 140, fontSize: 16, lineHeight: '24px' })
    expect(styles.diffModalStatus).toMatchObject({ fontSize: 16, lineHeight: '24px' })
    expect(modalButton).toMatchObject({ minHeight: 42, fontSize: 16, lineHeight: '24px' })
  })
})
