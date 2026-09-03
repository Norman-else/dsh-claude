import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  RepositoryStatusService,
  aggregateChecks,
  parseDiffNumstat,
  parseGitHubRemote,
  parseGitStatus,
  parsePullRequest,
  detectRepositoryOperation,
} from '../src/repository-status.ts'

function handle(stdout: string, exitCode = 0, lossy = false): SubprocessHandle {
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: async () => true,
  }
}

function runtime(results: Array<{ stdout: string; exitCode?: number; lossy?: boolean }>) {
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => {
    const result = results.shift()
    if (result === undefined) throw new Error('unexpected command')
    return handle(result.stdout, result.exitCode, result.lossy)
  })
  const resolveExecutable = vi.fn(async (name: string) => `/bin/${name}`)
  return { spawn, resolveExecutable }
}

describe('repository status parsing', () => {
  it('parses branches, detached heads, and tracked or untracked changes', () => {
    expect(parseGitStatus('# branch.head feature/status\n1 .M N... file.ts\n')).toEqual({
      branch: 'feature/status',
      detached: false,
      dirty: true,
      upstream: false,
    })
    expect(parseGitStatus('# branch.head (detached)\n')).toEqual({ detached: true, dirty: false, upstream: false })
    expect(parseGitStatus('# branch.head main\n? untracked.txt\n')).toEqual({
      branch: 'main',
      detached: false,
      dirty: true,
      upstream: false,
    })
    expect(parseGitStatus('# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n')).toEqual({
      branch: 'main',
      detached: false,
      dirty: false,
      upstream: true,
      ahead: 2,
      behind: 1,
    })
  })

  it('collects the unmerged paths a stopped operation is waiting on', () => {
    expect(parseGitStatus([
      '# branch.head (detached)',
      'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 src/conflict.ts',
      'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 src/with space.ts',
      '',
    ].join('\n'))).toEqual({
      detached: true,
      // Unmerged paths are changes too: the tree belongs to the merge.
      dirty: true,
      upstream: false,
      conflicts: ['src/conflict.ts', 'src/with space.ts'],
    })
  })

  it('parses bounded tracked diff statistics', () => {
    expect(parseDiffNumstat('2\t1\tsrc/a.ts\n-\t-\timage.png\n')).toEqual({ additions: 2, deletions: 1, files: 2 })
  })

  it('accepts only recognizable GitHub remotes', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo.git\n')).toBe('owner/repo')
    expect(parseGitHubRemote('git@github.com:owner/repo.git')).toBe('owner/repo')
    expect(parseGitHubRemote('ssh://git@github.com/owner/repo')).toBe('owner/repo')
    expect(parseGitHubRemote('https://example.com/owner/repo.git')).toBeUndefined()
  })

  it('aggregates checks and strictly normalizes pull requests', () => {
    expect(aggregateChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing')
    expect(aggregateChecks([{ status: 'IN_PROGRESS' }])).toBe('pending')
    expect(aggregateChecks([{ status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failing')
    expect(parsePullRequest({
      number: 12,
      title: 'Repository status',
      url: 'https://github.com/owner/repo/pull/12',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    })).toMatchObject({ number: 12, state: 'open', review: 'approved', checks: 'passing' })
    expect(parsePullRequest({
      number: 13,
      title: 'Merged repository status',
      url: 'https://github.com/owner/repo/pull/13',
      state: 'CLOSED',
      mergedAt: '2026-08-22T08:00:00Z',
      baseRefName: 'master',
    })).toMatchObject({
      number: 13,
      state: 'merged',
      mergedAt: '2026-08-22T08:00:00.000Z',
      baseBranch: 'master',
    })
    expect(parsePullRequest({ number: 1, title: 'bad', url: 'http://github.com/x/y/pull/1', state: 'OPEN' })).toBeUndefined()
  })
})

describe('repository status service', () => {
  it('returns Git and PR state through bounded explicit argv probes', async () => {
    const fake = runtime([
      { stdout: 'C:/repo\nC:/repo/.git/worktrees/status\nC:/repo/.git\n' },
      { stdout: '# branch.head feature/status\n' },
      { stdout: 'git@github.com:owner/repo.git\n' },
      { stdout: JSON.stringify({
        number: 12,
        title: 'Repository status',
        url: 'https://github.com/owner/repo/pull/12',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'REVIEW_REQUIRED',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [{ status: 'IN_PROGRESS' }],
        author: { login: 'norman-else' },
        createdAt: '2026-08-21T13:00:00Z',
        baseRefName: 'master',
      }) },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' },
      { stdout: '2\t1\tsrc/file.ts\n' },
      { stdout: 'diff --git a/src/file.ts b/src/file.ts\n@@ -1 +1 @@\n-old\n+new\n+more\n' },
      { stdout: '' },
      { stdout: '3\n' },
    ])
    const service = new RepositoryStatusService(fake, 60_000)
    await expect(service.inspect('C:/repo')).resolves.toEqual({
      status: 'ready',
      cwd: 'C:/repo',
      root: 'C:/repo',
      branch: 'feature/status',
      detached: false,
      worktree: true,
      dirty: false,
      upstream: false,
      remote: 'owner/repo',
      pullRequest: {
        number: 12,
        title: 'Repository status',
        url: 'https://github.com/owner/repo/pull/12',
        state: 'open',
        draft: false,
        review: 'review-required',
        checks: 'pending',
        mergeState: 'BLOCKED',
        author: 'norman-else',
        createdAt: '2026-08-21T13:00:00.000Z',
        baseBranch: 'master',
      },
      diff: {
        additions: 2,
        deletions: 1,
        files: 1,
        patch: 'diff --git a/src/file.ts b/src/file.ts\n@@ -1 +1 @@\n-old\n+new\n+more\n',
        truncated: false,
      },
      baseBehind: 3,
    })
    await service.inspect('C:/repo')
    expect(fake.spawn).toHaveBeenCalledTimes(9)
    expect(fake.spawn.mock.calls[0]?.[0]).toMatchObject({
      argv: ['/bin/git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      cwd: 'C:/repo',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
    })
    expect(fake.spawn.mock.calls[1]?.[0].argv).toEqual([
      '/bin/git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal',
    ])
    expect(fake.spawn.mock.calls[3]?.[0].argv).toEqual([
      '/bin/gh', 'pr', 'view', 'feature/status', '--repo', 'owner/repo', '--json',
      'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,mergedAt,statusCheckRollup,author,createdAt,baseRefName',
    ])
    expect(fake.spawn.mock.calls[4]?.[0].argv).toEqual(['/bin/git', 'merge-base', 'HEAD', 'refs/remotes/origin/master'])
    expect(fake.spawn.mock.calls[5]?.[0].argv).toEqual(['/bin/git', 'diff', '--no-ext-diff', '--numstat', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--'])
    expect(fake.spawn.mock.calls[6]?.[0]).toMatchObject({
      argv: ['/bin/git', 'diff', '--no-ext-diff', '--no-color', '--unified=3', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--'],
      stdio: { stdout: { maxBytes: 262_144 } },
    })
    expect(fake.spawn.mock.calls[7]?.[0].argv).toEqual(['/bin/git', 'ls-files', '--others', '--exclude-standard', '-z'])
  })

  it('keeps the last PR and its diff when a later gh probe is temporarily unavailable', async () => {
    const fake = runtime([
      { stdout: '/repo\n/repo/.git\n/repo/.git\n' },
      { stdout: '# branch.head feature/status\n' },
      { stdout: 'https://github.com/owner/repo.git\n' },
      { stdout: JSON.stringify({
        number: 12,
        title: 'Repository status',
        url: 'https://github.com/owner/repo/pull/12',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'APPROVED',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        baseRefName: 'master',
      }) },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' },
      { stdout: '2\t1\tsrc/file.ts\n' },
      { stdout: 'diff --git a/src/file.ts b/src/file.ts\n@@ -1 +1 @@\n-old\n+new\n' },
      { stdout: '' },
      { stdout: '/repo\n/repo/.git\n/repo/.git\n' },
      { stdout: '# branch.head feature/status\n' },
      { stdout: 'https://github.com/owner/repo.git\n' },
      { stdout: '', exitCode: 1 },
    ])
    const service = new RepositoryStatusService(fake, 0)
    const first = await service.inspect('/repo')
    const second = await service.inspect('/repo')
    expect(second.pullRequest).toEqual(first.pullRequest)
    expect(second.diff).toEqual(first.diff)
  })

  it('omits a truncated patch while preserving bounded diff statistics', async () => {
    const fake = runtime([
      { stdout: '/repo\n/repo/.git\n/repo/.git\n' },
      { stdout: '# branch.head main\n1 .M N... file.ts\n' },
      { stdout: '', exitCode: 2 },
      { stdout: '4\t3\tfile.ts\n' },
      { stdout: 'partial patch', lossy: true },
      { stdout: '' },
    ])
    await expect(new RepositoryStatusService(fake).inspect('/repo')).resolves.toMatchObject({
      status: 'ready',
      diff: { additions: 4, deletions: 3, files: 1, truncated: true },
    })
    const result = await new RepositoryStatusService(runtime([
      { stdout: '/repo\n/repo/.git\n/repo/.git\n' },
      { stdout: '# branch.head main\n1 .M N... file.ts\n' },
      { stdout: '', exitCode: 2 },
      { stdout: '4\t3\tfile.ts\n' },
      { stdout: 'partial patch', lossy: true },
      { stdout: '' },
    ])).inspect('/repo')
    expect(result.diff).not.toHaveProperty('patch')
  })

  it('counts untracked files and their lines in the working tree diff', async () => {
    const fake = runtime([
      { stdout: '/repo\n/repo/.git\n/repo/.git\n' },
      { stdout: '# branch.head main\n1 .M N... file.ts\n? new.ts\n' },
      { stdout: '', exitCode: 2 },
      { stdout: '2\t1\tfile.ts\n' },
      { stdout: 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n+more\n' },
      { stdout: 'new.ts\0empty.ts\0' },
      { stdout: '3\t0\tnul => new.ts\ndiff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n', exitCode: 1 },
      { stdout: '' },
    ])
    const status = await new RepositoryStatusService(fake).inspect('/repo')
    expect(status.diff).toMatchObject({ additions: 5, deletions: 1, files: 3, truncated: false })
    expect(status.diff?.patch).toContain('diff --git a/file.ts b/file.ts')
    expect(status.diff?.patch).toContain('diff --git a/new.ts b/new.ts')
    expect(fake.spawn.mock.calls[5]?.[0].argv).toEqual(['/bin/git', 'ls-files', '--others', '--exclude-standard', '-z'])
    expect(fake.spawn.mock.calls[6]?.[0].argv).toEqual([
      '/bin/git', 'diff', '--no-ext-diff', '--no-color', '--unified=3', '--numstat', '--patch', '--no-index', '--', '/dev/null', 'new.ts',
    ])
  })

  it('degrades for non-repositories and unavailable executables without leaking errors', async () => {
    const notRepo = runtime([{ stdout: 'fatal details', exitCode: 128 }])
    await expect(new RepositoryStatusService(notRepo).inspect('/tmp')).resolves.toEqual({
      status: 'not-repository',
      cwd: '/tmp',
    })
    const unavailable = runtime([])
    unavailable.resolveExecutable.mockRejectedValueOnce(new Error('secret executable failure'))
    await expect(new RepositoryStatusService(unavailable).inspect('/private')).resolves.toEqual({
      status: 'unavailable',
      cwd: '/private',
    })
  })

  it('keeps Git state when gh is unavailable', async () => {
    const fake = runtime([
      { stdout: '/repo\n/repo/.git\n/repo/.git\n' },
      { stdout: '# branch.head main\n' },
      { stdout: 'https://github.com/owner/repo.git\n' },
    ])
    fake.resolveExecutable.mockImplementation(async (name: string) => {
      if (name === 'gh') throw new Error('not installed')
      return '/bin/git'
    })
    await expect(new RepositoryStatusService(fake).inspect('/repo')).resolves.toMatchObject({
      status: 'ready', branch: 'main', worktree: false, dirty: false, remote: 'owner/repo',
    })
  })
})

describe('in-progress operations', () => {
  it('names the stopped operation and the branch a rebase parked', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'dsh-claude-gitdir-'))
    expect(await detectRepositoryOperation(gitDir)).toBeUndefined()
    await mkdir(join(gitDir, 'rebase-merge'))
    await writeFile(join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/feature/status\n', 'utf8')
    expect(await detectRepositoryOperation(gitDir)).toEqual({ operation: 'rebase', branch: 'feature/status' })
  })

  it('reports a merge without inventing a branch for it', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'dsh-claude-gitdir-'))
    await writeFile(join(gitDir, 'MERGE_HEAD'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', 'utf8')
    expect(await detectRepositoryOperation(gitDir)).toEqual({ operation: 'merge' })
  })

  it('keeps the branch and its pull request through a conflicted rebase', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'dsh-claude-gitdir-'))
    await mkdir(join(gitDir, 'rebase-merge'))
    await writeFile(join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/feature/status\n', 'utf8')
    const fake = runtime([
      { stdout: `/repo\n${gitDir}\n${gitDir}\n` },
      { stdout: '# branch.head (detached)\nu UU N... 100644 100644 100644 100644 1 2 3 src/a.ts\n' },
      { stdout: 'git@github.com:owner/repo.git\n' },
      { stdout: JSON.stringify({
        number: 12,
        title: 'Repository status',
        url: 'https://github.com/owner/repo/pull/12',
        state: 'OPEN',
        baseRefName: 'master',
      }) },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '0\n' },
    ])
    const status = await new RepositoryStatusService(fake, 60_000).inspect('/repo')
    // Git only says `(detached)` while it replays, so the bar would otherwise
    // lose the branch, its pull request and every control keyed on them.
    expect(status).toMatchObject({
      branch: 'feature/status',
      detached: true,
      operation: 'rebase',
      conflicts: ['src/a.ts'],
      pullRequest: { number: 12, baseBranch: 'master' },
    })
    expect(fake.spawn.mock.calls[3]?.[0].argv).toContain('feature/status')
  })
})

describe('repository file lines', () => {
  it('slices working-tree files inside the repository and refuses escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-claude-file-'))
    await writeFile(join(root, 'a.txt'), 'l1\nl2\nl3\nl4\n')
    const service = new RepositoryStatusService(runtime([{ stdout: `${root}\n` }, { stdout: `${root}\n` }]))
    await expect(service.fileLines(root, 'a.txt', 2, 3)).resolves.toEqual({ lines: ['l2', 'l3'], total: 4 })
    await expect(service.fileLines(root, 'a.txt', 4, 10)).resolves.toEqual({ lines: ['l4'], total: 4 })
    await expect(service.fileLines(root, '../a.txt', 1, 2)).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(service.fileLines(root, 'a.txt', 3, 2)).rejects.toMatchObject({ code: 'invalid-request' })
  })
})
