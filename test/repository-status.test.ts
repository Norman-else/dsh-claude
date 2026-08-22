import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  RepositoryStatusService,
  aggregateChecks,
  parseDiffNumstat,
  parseGitHubRemote,
  parseGitStatus,
  parsePullRequest,
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
  it('parses branches, detached heads, and tracked changes', () => {
    expect(parseGitStatus('# branch.head feature/status\n1 .M N... file.ts\n')).toEqual({
      branch: 'feature/status',
      detached: false,
      dirty: true,
    })
    expect(parseGitStatus('# branch.head (detached)\n')).toEqual({ detached: true, dirty: false })
    expect(parseGitStatus('# branch.head main\n? ignored-untracked\n')).toEqual({
      branch: 'main',
      detached: false,
      dirty: true,
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
    })
    await service.inspect('C:/repo')
    expect(fake.spawn).toHaveBeenCalledTimes(7)
    expect(fake.spawn.mock.calls[0]?.[0]).toMatchObject({
      argv: ['/bin/git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      cwd: 'C:/repo',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
    })
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
    ])).inspect('/repo')
    expect(result.diff).not.toHaveProperty('patch')
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
