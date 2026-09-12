// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeDiffPanel } from '../src/client/ClaudeDiffPanel.tsx'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replaceAll(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

const patch = (file: string): string => `diff --git a/${file} b/${file}\n@@ -1,1 +1,2 @@\n const a = 1\n+const b = 2\n`

const own = { status: 'ready' as const, cwd: '/a', root: '/a', branch: 'feature', remote: 'org/a', diff: { additions: 1, deletions: 0, files: 1, truncated: false, patch: patch('own.ts') } }
const other = { status: 'ready' as const, cwd: '/b', root: '/b', branch: 'fix', remote: 'org/b', diff: { additions: 1, deletions: 0, files: 1, truncated: false, patch: patch('other.ts') } }

let mounted: { root: Root; container: HTMLElement } | undefined

function mount(projection: ClaudeClientProjection, initialRoot?: string): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  act(() => {
    root.render(<ClaudeDiffPanel
      t={t}
      sessionId="session-1"
      closeDetails={vi.fn()}
      {...(initialRoot === undefined ? {} : { initialRoot })}
      useClaudeProjection={(<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(projection)) as never}
    />)
  })
  return container
}

afterEach(() => {
  if (mounted === undefined) return
  act(() => { mounted?.root.unmount() })
  mounted.container.remove()
  mounted = undefined
})

describe('Claude diff panel repository switch', () => {
  /** The DSH menu trigger, never a native form control. */
  function trigger(container: HTMLElement): HTMLButtonElement | undefined {
    expect(container.querySelector('select')).toBeNull()
    return [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === en.diffRepository)
  }

  it('offers no switch while the session only touched its own checkout', () => {
    const container = mount({ ...EMPTY_CLAUDE_PROJECTION, owned: true, repository: own })
    expect(trigger(container)).toBeUndefined()
    expect(container.textContent).toContain('own.ts')
  })

  it('lists every checkout the session wrote into and shows the chosen one', () => {
    const container = mount({ ...EMPTY_CLAUDE_PROJECTION, owned: true, repository: own, repositories: [other] })
    const button = trigger(container)
    if (button === undefined) throw new Error('no repository switch')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.textContent).toContain('a')
    expect(container.textContent).toContain('own.ts')
    expect(container.textContent).not.toContain('other.ts')
    act(() => { button.click() })
    // Each row carries its own counts, so both changes are visible at once.
    const rows = [...document.querySelectorAll('[role="menuitem"]')]
    expect(rows.map(row => row.textContent)).toEqual(['a +1 −0', 'b +1 −0'])
    act(() => { (rows[1] as HTMLElement).click() })
    expect(container.textContent).toContain('other.ts')
    expect(container.textContent).toContain('fix')
    expect(container.textContent).not.toContain('own.ts')
    expect(trigger(container)?.textContent).toContain('b')
  })

  it('opens on the checkout that changed when the session checkout is clean', () => {
    const clean = { ...own, diff: { ...own.diff, additions: 0, deletions: 0, files: 0, patch: '' } }
    const container = mount({ ...EMPTY_CLAUDE_PROJECTION, owned: true, repository: clean, repositories: [other] })
    expect(trigger(container)?.textContent).toContain('b')
    expect(container.textContent).toContain('other.ts')
  })

  it('shows a linked pull request through its own diff, without offering to expand context it has no tree for', async () => {
    const { panelRepositories } = await import('../src/client/ClaudeDiffPanel.tsx')
    const pullRequest = { number: 7, title: 'T', url: 'https://github.com/org/b/pull/7', state: 'open' as const, draft: false, review: 'none' as const, checks: 'none' as const }
    const bare = { status: 'ready' as const, cwd: '/a', remote: 'org/b', branch: 'fix', pullRequestOnly: true, pullRequest }
    expect(panelRepositories({ repository: own, repositories: [bare, other] }).map(item => item.root)).toEqual(['/a', '/b'])
    const gapped = 'diff --git a/pr.ts b/pr.ts\n@@ -10,1 +10,2 @@\n const a = 1\n+const b = 2\n'
    const withDiff = { ...bare, root: '/clone-b', diff: { additions: 1, deletions: 0, files: 1, truncated: false, patch: gapped } }
    expect(panelRepositories({ repository: own, repositories: [withDiff] }).map(item => item.root)).toEqual(['/a', '/clone-b'])
    const container = mount({ ...EMPTY_CLAUDE_PROJECTION, owned: true, repository: own, repositories: [withDiff] }, '/clone-b')
    expect(container.textContent).toContain('pr.ts')
    // The clone attached to the pull request sits on another branch: its files
    // are not the ones this patch applies to, so the gap stays unexpandable.
    const expanders = [...container.querySelectorAll('button')].filter(item => [en.diffExpandUp, en.diffExpandDown].includes(item.getAttribute('aria-label') ?? ''))
    expect(expanders.length).toBeGreaterThan(0)
    expect(expanders.every(item => item.disabled)).toBe(true)
  })

  it('opens on the requested checkout', () => {
    const container = mount({ ...EMPTY_CLAUDE_PROJECTION, owned: true, repository: own, repositories: [other] }, '/b')
    expect(trigger(container)?.textContent).toContain('b')
    expect(container.textContent).toContain('other.ts')
  })
})

describe('Claude repository bar with linked checkouts', () => {
  it('renders one linked bar per other checkout, below the session bar, with its own diff and pull request', async () => {
    const { ClaudeRepositoryStatus } = await import('../src/client/ClaudeRepositoryStatus.tsx')
    const openDiff = vi.fn()
    const linked = {
      ...other,
      worktree: true,
      diff: { ...other.diff, additions: 3, deletions: 2 },
      pullRequest: { number: 7, title: 'Types', url: 'https://github.com/org/b/pull/7', state: 'open' as const, draft: false, review: 'approved' as const, checks: 'passing' as const },
    }
    const projection: ClaudeClientProjection = { ...EMPTY_CLAUDE_PROJECTION, owned: true, repository: own, repositories: [linked] }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted = { root, container }
    act(() => {
      root.render(<ClaudeRepositoryStatus
        sessionId="session-1"
        t={t}
        openDiff={openDiff}
        useSessions={(<S,>(selector: (value: { byId: Record<string, { blank: boolean; running?: boolean }> }) => S): S => selector({ byId: { 'session-1': { blank: false } } })) as never}
        useClaudeProjection={(<S,>(selector: (value: ClaudeClientProjection) => S): S => selector(projection)) as never}
      />)
    })
    const bars = [...container.querySelectorAll('[data-dsh-claude-linked-repository]')]
    expect(bars.map(bar => bar.getAttribute('data-dsh-claude-linked-repository'))).toEqual(['/b'])
    const bar = bars[0] as HTMLElement
    // Linked bars stack above; the session bar stays last, next to the composer.
    expect(container.textContent?.indexOf('fix')).toBeLessThan(container.textContent?.indexOf('feature') ?? -1)
    expect(bar.textContent).toContain('b')
    expect(bar.textContent).toContain('fix')
    expect(bar.textContent).toContain(en.repositoryWorktree)
    expect(bar.textContent).toContain('#7')
    expect(bar.querySelector(`[aria-label="${en.repositoryChecks_passing}"]`)).not.toBeNull()
    expect(bar.querySelector(`[aria-label="${en.repositoryReview_approved}"]`)).not.toBeNull()
    expect(bar.querySelector('[role="img"][aria-label="' + en.repositoryLinked + '"]')).not.toBeNull()
    const diff = [...bar.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === en.diffOpen)
    if (diff === undefined) throw new Error('no diff button on the linked bar')
    expect(diff.textContent).toContain('+3')
    expect(diff.textContent).toContain('−2')
    act(() => { diff.click() })
    expect(openDiff).toHaveBeenCalledWith('/b')
  })

  it('carries the session bar controls, scoped to the linked checkout', async () => {
    const api = await import('../src/client/repository-action-api.ts')
    vi.spyOn(api, 'loadRepositoryActionPreview').mockResolvedValue({
      root: '/b', branch: 'fix', head: 'h', fingerprint: 'f', files: [], patch: '', truncated: false,
      hasStaged: false, hasUnstaged: false, hasUntracked: false, unpushedCommits: [], unpushedTruncated: false,
    })
    const execute = vi.spyOn(api, 'executeRepositoryAction').mockResolvedValue({ commit: 'h', pushed: true })
    const { LinkedRepositoryBar } = await import('../src/client/ClaudeRepositoryStatus.tsx')
    const linked = {
      ...other,
      pullRequest: { number: 7, title: 'T', url: 'https://github.com/org/b/pull/7', state: 'open' as const, draft: false, review: 'none' as const, checks: 'failing' as const, baseBranch: 'main' },
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted = { root, container }
    act(() => { root.render(<LinkedRepositoryBar sessionId="session-1" repository={linked} running={false} t={t} openDiff={vi.fn()} report={vi.fn()} submitPrompt={vi.fn()} />) })
    const labels = [...container.querySelectorAll('button')].map(item => item.getAttribute('aria-label'))
    expect(labels).toEqual(expect.arrayContaining([en.repositoryChecksOpen, en.autoFixLabel, en.repositoryMergeMenu]))
    const menu = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === en.repositoryMergeMenu)
    act(() => { menu?.click() })
    const squash = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === en.diffMerge_squash)
    await act(async () => { (squash as HTMLElement).click() })
    const confirm = [...document.querySelectorAll('button')].find(item => item.textContent === en.diffConfirm)
    await act(async () => { confirm?.click() })
    expect(execute).toHaveBeenCalledWith('session-1', expect.objectContaining({ action: 'merge-pr', mergeMethod: 'squash', pullNumber: 7 }), '/b')
    vi.restoreAllMocks()
  })

  it('acts on a pull request without a checkout of its own only through a local clone of that repository', async () => {
    const { LinkedRepositoryBar } = await import('../src/client/ClaudeRepositoryStatus.tsx')
    const pullRequest = { number: 7, title: 'T', url: 'https://github.com/org/b/pull/7', state: 'merged' as const, draft: false, review: 'none' as const, checks: 'none' as const, baseBranch: 'main' }
    const render = (repository: ClaudeClientProjection['repository']): string[] => {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      mounted = { root, container }
      act(() => { root.render(<LinkedRepositoryBar sessionId="session-1" repository={repository!} running={false} t={t} openDiff={vi.fn()} report={vi.fn()} />) })
      const labels = [...container.querySelectorAll('button')].map(item => item.getAttribute('aria-label') ?? item.textContent ?? '')
      act(() => { root.unmount() })
      container.remove()
      mounted = undefined
      return labels
    }
    // Merged, cleaned up already on the far side: nothing to clean up here, no diff to open.
    const detached = render({ status: 'ready', cwd: '/a', remote: 'org/b', branch: 'fix', pullRequestOnly: true, pullRequest })
    expect(detached).not.toContain(en.cleanupButton)
    expect(detached).not.toContain(en.diffOpen)
    // Open and reachable through a clone: the merge menu is there.
    const open = render({ status: 'ready', cwd: '/b', root: '/b', remote: 'org/b', branch: 'fix', pullRequestOnly: true, pullRequest: { ...pullRequest, state: 'open' } })
    expect(open).toContain(en.repositoryMergeMenu)
    const unreachable = render({ status: 'ready', cwd: '/a', remote: 'org/b', branch: 'fix', pullRequestOnly: true, pullRequest: { ...pullRequest, state: 'open' } })
    expect(unreachable).not.toContain(en.repositoryMergeMenu)
  })

  it('draws the auto-fix switch as a filled toggle when on, and shows a ring only for keyboard focus', async () => {
    const { AutoFixControl } = await import('../src/client/ClaudeRepositoryStatus.tsx')
    const styles = await import('../src/client/styles.ts')
    const repository = { ...other, pullRequest: { number: 7, title: 'T', url: 'https://github.com/org/b/pull/7', state: 'open' as const, draft: false, review: 'none' as const, checks: 'none' as const } }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted = { root, container }
    act(() => { root.render(<><style>{styles.repositoryAutoFixCss}</style><AutoFixControl sessionId="session-1" repository={repository} root="/b" running={false} t={t} submitPrompt={vi.fn(() => true)} /></>) })
    const button = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === en.autoFixLabel)
    if (button === undefined) throw new Error('no auto-fix switch')
    expect(button.className).toBe(styles.repositoryAutoFixClass)
    // The on state is a stylesheet rule keyed off aria-checked, not an inline
    // ring that a mouse click could leave behind; a mouse click also drops focus.
    expect(button.getAttribute('aria-checked')).toBe('false')
    act(() => { button.focus(); button.click() })
    expect(button.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).not.toBe(button)
    expect(button.getAttribute('style') ?? '').not.toContain('box-shadow')
    expect(styles.repositoryAutoFixCss).toContain(`.${styles.repositoryAutoFixClass}[aria-checked="true"]`)
    expect(styles.repositoryAutoFixCss).toContain(`.${styles.repositoryAutoFixClass}:focus-visible`)
  })

  it('offers clean-up on a linked checkout whose pull request merged', async () => {
    const { LinkedRepositoryBar } = await import('../src/client/ClaudeRepositoryStatus.tsx')
    const merged = {
      ...other,
      worktree: true,
      pullRequest: { number: 7, title: 'Types', url: 'https://github.com/org/b/pull/7', state: 'merged' as const, draft: false, review: 'none' as const, checks: 'none' as const, baseBranch: 'main' },
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted = { root, container }
    act(() => { root.render(<LinkedRepositoryBar sessionId="session-1" repository={merged} running={false} t={t} openDiff={vi.fn()} report={vi.fn()} />) })
    expect([...container.querySelectorAll('button')].some(item => item.textContent === en.cleanupButton)).toBe(true)
  })
})

describe('merge pull request dialog', () => {
  it('offers an administrator merge that bypasses branch protection', async () => {
    const api = await import('../src/client/repository-action-api.ts')
    const preview = vi.spyOn(api, 'loadRepositoryActionPreview').mockResolvedValue({
      root: '/a', branch: 'feature', head: 'h', fingerprint: 'f', files: [], patch: '', truncated: false,
      hasStaged: false, hasUnstaged: false, hasUntracked: false, unpushedCommits: [], unpushedTruncated: false,
    })
    const execute = vi.spyOn(api, 'executeRepositoryAction').mockResolvedValue({ commit: 'h', pushed: true })
    const { MergePullRequestControl } = await import('../src/client/ClaudeRepositoryStatus.tsx')
    const repository = {
      ...own,
      pullRequest: { number: 3, title: 'T', url: 'https://github.com/org/a/pull/3', state: 'open' as const, draft: false, review: 'none' as const, checks: 'none' as const, baseBranch: 'main' },
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted = { root, container }
    act(() => { root.render(<MergePullRequestControl sessionId="session-1" repository={repository} t={t} report={vi.fn()} />) })
    const menu = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === en.repositoryMergeMenu)
    if (menu === undefined) throw new Error('no merge menu')
    act(() => { menu.click() })
    const squash = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === en.diffMerge_squash)
    if (squash === undefined) throw new Error('no squash row')
    await act(async () => { (squash as HTMLElement).click() })
    expect(preview).toHaveBeenCalled()
    const admin = document.querySelector<HTMLInputElement>('input[type="checkbox"][name="dsh-claude-merge-admin"]')
    if (admin === null) throw new Error('no admin checkbox')
    expect(admin.checked).toBe(false)
    expect(document.body.textContent).toContain(en.diffMergeAdmin)
    act(() => { admin.click() })
    const confirm = [...document.querySelectorAll('button')].find(item => item.textContent === en.diffConfirm)
    if (confirm === undefined) throw new Error('no confirm button')
    await act(async () => { confirm.click() })
    // The session's own checkout: no root, and the merge follows the branch rather than naming a number.
    expect(execute).toHaveBeenCalledWith('session-1', expect.objectContaining({ action: 'merge-pr', mergeMethod: 'squash', admin: true }), undefined)
    expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('pullNumber')
    vi.restoreAllMocks()
  })
})
