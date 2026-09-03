import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  RepositoryActionError,
  RepositoryActionService,
  isProtectedWarpPath,
  parseRepositoryActionStatus,
} from '../src/repository-actions.ts'

interface Result { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number; readonly lossy?: boolean }

function handle(result: Result): SubprocessHandle {
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: result.lossy ?? false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: async () => true,
  }
}

function runtime(results: Result[]) {
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => {
    const result = results.shift()
    if (result === undefined) throw new Error('unexpected command')
    return handle(result)
  })
  return {
    spawn,
    resolveExecutable: vi.fn(async (name: string) => `C:/bin/${name}.exe`),
  }
}

const previewResults = (status = ' M src/a.ts\n?? src/new.ts\n?? nested/WARP.md\n'): Result[] => [
  { stdout: 'C:/repo\n' },
  { stdout: 'feature/actions\n' },
  { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' },
  { stdout: status },
  { stdout: '' },
  { stdout: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' },
  { stdout: 'origin/feature/actions\n' },
  { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tUpdate repository actions\n' },
]

describe('repository action parsing', () => {
  it('classifies staged, unstaged, untracked, renamed, and protected paths', () => {
    expect(parseRepositoryActionStatus([
      'M  staged.ts',
      ' M unstaged.ts',
      '?? new.ts',
      'R  old.ts -> renamed.ts',
      '?? nested/WARP.md',
      ' M nested\\warp.md',
    ].join('\n'))).toEqual([
      { path: 'new.ts', staged: false, unstaged: false, untracked: true },
      { path: 'renamed.ts', staged: true, unstaged: false, untracked: false },
      { path: 'staged.ts', staged: true, unstaged: false, untracked: false },
      { path: 'unstaged.ts', staged: false, unstaged: true, untracked: false },
    ])
    expect(isProtectedWarpPath('WARP.md')).toBe(true)
    expect(isProtectedWarpPath('nested/warp.MD')).toBe(true)
    expect(isProtectedWarpPath('WARP.md.bak')).toBe(false)
    expect(parseRepositoryActionStatus('R  renamed.ts\0old.ts\0?? space name.ts\0')).toEqual([
      { path: 'renamed.ts', staged: true, unstaged: false, untracked: false },
      { path: 'space name.ts', staged: false, unstaged: false, untracked: true },
    ])
  })
})

describe('repository action service', () => {
  it('generates a bounded message with an isolated tool-free Claude invocation', async () => {
    const fake = runtime([...previewResults(), ...previewResults(), { stdout: 'Update repository actions\n' }])
    const service = new RepositoryActionService(fake, 'C:/bin/claude.exe')
    const preview = await service.preview('C:/repo/session')
    await expect(service.generateMessage('C:/repo/session', preview.fingerprint)).resolves.toBe('Update repository actions')
    const command = fake.spawn.mock.calls.at(-1)?.[0]
    // No MCP servers and no user hooks: a commit subject cannot use either, and
    // both are what makes the cold start of this one-shot run drag.
    expect(command).toMatchObject({
      cwd: 'C:/repo',
      env: {},
      argv: [
        'C:/bin/claude.exe', '-p',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--setting-sources', 'project,local',
        '--tools', '', '--output-format', 'text', expect.any(String),
      ],
    })
    expect(command.argv.at(-1)).not.toContain('WARP.md')
  })

  it('rejects a stale fingerprint before staging anything', async () => {
    const fake = runtime(previewResults())
    const service = new RepositoryActionService(fake, 'claude')
    await expect(service.execute('C:/repo', {
      action: 'commit', fingerprint: 'stale', message: 'Update files', includeUnstaged: true,
    })).rejects.toMatchObject({ code: 'repository-changed' })
    expect(fake.spawn.mock.calls.some(call => call[0].argv.includes('add'))).toBe(false)
  })

  it('stages only confirmed non-protected paths and commits through explicit argv', async () => {
    const fake = runtime([
      ...previewResults(),
      ...previewResults(),
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '', exitCode: 1 },
      { stdout: '[feature/actions bbbbbbb] Update files\n' },
      { stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' },
    ])
    const invalidated = vi.fn()
    const service = new RepositoryActionService(fake, 'claude', invalidated)
    const initial = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'commit', fingerprint: initial.fingerprint, message: 'Update files', includeUnstaged: true,
    })).resolves.toEqual({ commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', pushed: false })
    const argv = fake.spawn.mock.calls.map(call => call[0].argv)
    expect(argv).toContainEqual(['C:/bin/git.exe', 'add', '--', 'src/a.ts', 'src/new.ts'])
    expect(argv).toContainEqual(['C:/bin/git.exe', 'commit', '-m', 'Update files', '--'])
    expect(argv.flat()).not.toContain('nested/WARP.md')
    expect(invalidated).toHaveBeenCalledWith('C:/repo')
  })

  it('refuses an already staged WARP.md', async () => {
    const fake = runtime([
      ...previewResults('M  src/a.ts\nM  WARP.md\n'),
      ...previewResults('M  src/a.ts\nM  WARP.md\n'),
      { stdout: 'WARP.md\n' },
    ])
    const service = new RepositoryActionService(fake, 'claude')
    const initial = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'commit', fingerprint: initial.fingerprint, message: 'Update files', includeUnstaged: false,
    })).rejects.toMatchObject({ code: 'protected-warp-file' })
  })

  it('exposes the upstream and unpushed commits in the preview', async () => {
    const fake = runtime(previewResults())
    const service = new RepositoryActionService(fake, 'claude')
    const preview = await service.preview('C:/repo')
    expect(preview.upstream).toBe('origin/feature/actions')
    expect(preview.unpushedCommits).toEqual([
      { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'Update repository actions' },
    ])
    expect(preview.unpushedTruncated).toBe(false)
    expect(fake.spawn.mock.calls.at(-1)?.[0].argv).toEqual([
      'C:/bin/git.exe', 'log', '--format=%H%x09%s', '-n', '21', '@{upstream}..HEAD', '--',
    ])
  })

  it('pushes existing commits without creating a new commit', async () => {
    const fake = runtime([
      ...previewResults(''),
      ...previewResults(''),
      { stdout: 'origin/feature/actions\n' },
      { stdout: '' },
    ])
    const invalidated = vi.fn()
    const service = new RepositoryActionService(fake, 'claude', invalidated)
    const initial = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'push', fingerprint: initial.fingerprint, message: '', includeUnstaged: false,
    })).resolves.toEqual({ commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pushed: true })
    expect(fake.spawn.mock.calls.some(call => call[0].argv.includes('commit'))).toBe(false)
    expect(fake.spawn.mock.calls.at(-1)?.[0].argv).toEqual(['C:/bin/git.exe', 'push'])
    expect(invalidated).toHaveBeenCalledWith('C:/repo')
  })

  it('creates a PR from already committed work without a new commit', async () => {
    const fake = runtime([
      ...previewResults(''),
      ...previewResults(''),
      { stdout: 'origin/feature/actions\n' },
      { stdout: '' },
      { stdout: 'https://github.com/owner/repo/pull/7\n' },
    ])
    const service = new RepositoryActionService(fake, 'claude')
    const initial = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'create-pr', fingerprint: initial.fingerprint, message: 'Update files', includeUnstaged: false,
      prTitle: 'Update files', prBody: 'Summary: Update files\n\nChanges:\n- Updated files',
    })).resolves.toEqual({
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      pushed: true,
      pullRequestUrl: 'https://github.com/owner/repo/pull/7',
    })
    expect(fake.spawn.mock.calls.some(call => call[0].argv.includes('commit'))).toBe(false)
  })

  it('preserves the completed commit when push fails', async () => {
    const fake = runtime([
      ...previewResults('M  src/a.ts\n'),
      ...previewResults('M  src/a.ts\n'),
      { stdout: '' },
      { stdout: '' },
      { stdout: '', exitCode: 1 },
      { stdout: '' },
      { stdout: 'cccccccccccccccccccccccccccccccccccccccc\n' },
      { stdout: '', exitCode: 1 },
      { stdout: '', stderr: 'private remote details', exitCode: 1 },
    ])
    const service = new RepositoryActionService(fake, 'claude')
    const initial = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'commit-push', fingerprint: initial.fingerprint, message: 'Update files', includeUnstaged: false,
    })).rejects.toEqual(expect.objectContaining({ code: 'push-failed', commit: 'cccccccccccccccccccccccccccccccccccccccc' }))
    const push = fake.spawn.mock.calls.at(-1)?.[0].argv
    expect(push).toEqual(['C:/bin/git.exe', 'push', '--set-upstream', 'origin', 'feature/actions'])
  })

  it('requires a PR description containing only Summary and Changes', async () => {
    const fake = runtime([
      ...previewResults('M  src/a.ts\n'),
      ...previewResults('M  src/a.ts\n'),
      { stdout: '' }, { stdout: '' }, { stdout: '', exitCode: 1 }, { stdout: '' },
      { stdout: 'dddddddddddddddddddddddddddddddddddddddd\n' },
      { stdout: 'origin/feature/actions\n' }, { stdout: '' },
    ])
    const service = new RepositoryActionService(fake, 'claude')
    const initial = await service.preview('C:/repo')
    const error = await service.execute('C:/repo', {
      action: 'create-pr', fingerprint: initial.fingerprint, message: 'Update files', includeUnstaged: false,
      prTitle: 'Update files', prBody: 'Summary: Update files\n\nChanges:\n- Updated files\n\nTesting:\n- Tests',
    }).catch(value => value)
    expect(error).toBeInstanceOf(RepositoryActionError)
    expect(error).toMatchObject({ code: 'invalid-pr-description', commit: 'dddddddddddddddddddddddddddddddddddddddd' })
    expect(fake.resolveExecutable).not.toHaveBeenCalledWith('gh')
  })
})

describe('repository pull request merge', () => {
  const head = 'a'.repeat(40)

  it('merges the branch PR through gh with the selected method', async () => {
    const fake = runtime([...previewResults(), ...previewResults(), { stdout: '' }])
    const invalidated = vi.fn()
    const service = new RepositoryActionService(fake, 'claude', invalidated)
    const preview = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'merge-pr', fingerprint: preview.fingerprint, message: '', includeUnstaged: false, mergeMethod: 'squash',
    })).resolves.toEqual({ commit: head, pushed: true })
    const command = fake.spawn.mock.calls.at(-1)?.[0]
    expect(command).toMatchObject({ cwd: 'C:/repo', argv: ['C:/bin/gh.exe', 'pr', 'merge', '--squash'] })
    expect(invalidated).toHaveBeenCalledWith('C:/repo')
  })

  it('rejects unknown merge methods before touching gh', async () => {
    const fake = runtime([...previewResults(), ...previewResults()])
    const service = new RepositoryActionService(fake, 'claude')
    const preview = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'merge-pr', fingerprint: preview.fingerprint, message: '', includeUnstaged: false,
    })).rejects.toMatchObject({ code: 'invalid-request' })
    expect(fake.spawn.mock.calls.every(call => !call[0].argv.includes('merge'))).toBe(true)
  })

  it('surfaces the gh failure reason when the merge is blocked', async () => {
    const fake = runtime([...previewResults(), ...previewResults(), {
      stderr: 'X Pull request #12 is not mergeable: the base branch policy prohibits the merge.\n',
      exitCode: 1,
    }])
    const service = new RepositoryActionService(fake, 'claude')
    const preview = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'merge-pr', fingerprint: preview.fingerprint, message: '', includeUnstaged: false, mergeMethod: 'merge',
    })).rejects.toMatchObject({
      code: 'merge-failed',
      message: 'X Pull request #12 is not mergeable: the base branch policy prohibits the merge.',
    })
  })
})

describe('repository branch update', () => {
  const head = 'a'.repeat(40)
  const merged = 'c'.repeat(40)

  const updateResults = () => [
    ...previewResults(''),
    ...previewResults(''),
    { stdout: '' },
    { stdout: '' },
    { stdout: `${merged}\n` },
    { stdout: 'origin/feature/actions\n' },
    { stdout: '' },
  ]

  it('rebases onto the base branch by default and pushes with --force-with-lease', async () => {
    const fake = runtime(updateResults())
    const service = new RepositoryActionService(fake, 'claude')
    const preview = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'update-branch', fingerprint: preview.fingerprint, message: '', includeUnstaged: false, baseBranch: 'master',
    })).resolves.toEqual({ commit: merged, pushed: true })
    const argv = fake.spawn.mock.calls.map(call => call[0].argv)
    expect(argv).toContainEqual(['C:/bin/git.exe', 'fetch', 'origin', '--', 'master'])
    expect(argv).toContainEqual(['C:/bin/git.exe', 'rebase', '--', 'origin/master'])
    expect(argv.at(-1)).toEqual(['C:/bin/git.exe', 'push', '--force-with-lease'])
  })

  it('merges the base branch and pushes the merge commit when asked to merge', async () => {
    const fake = runtime(updateResults())
    const service = new RepositoryActionService(fake, 'claude')
    const preview = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'update-branch', fingerprint: preview.fingerprint, message: '', includeUnstaged: false, baseBranch: 'master', mergeMethod: 'merge',
    })).resolves.toEqual({ commit: merged, pushed: true })
    const argv = fake.spawn.mock.calls.map(call => call[0].argv)
    expect(argv).toContainEqual(['C:/bin/git.exe', 'merge', '--no-edit', '--', 'origin/master'])
    expect(argv.at(-1)).toEqual(['C:/bin/git.exe', 'push'])
  })

  it('reports conflicted files and leaves the rebase in place', async () => {
    const fake = runtime([
      ...previewResults(''),
      ...previewResults(''),
      { stdout: '' },
      { stdout: '', exitCode: 1 },
      { stdout: 'src/a.ts\nsrc/b.ts\n' },
    ])
    const service = new RepositoryActionService(fake, 'claude')
    const preview = await service.preview('C:/repo')
    await expect(service.execute('C:/repo', {
      action: 'update-branch', fingerprint: preview.fingerprint, message: '', includeUnstaged: false, baseBranch: 'master',
    })).resolves.toEqual({ commit: head, pushed: false, conflicts: ['src/a.ts', 'src/b.ts'] })
    expect(fake.spawn.mock.calls.every(call => !call[0].argv.includes('--abort'))).toBe(true)
  })

  it('rejects dirty trees and missing base branches before merging', async () => {
    const dirty = runtime([...previewResults(), ...previewResults()])
    const dirtyService = new RepositoryActionService(dirty, 'claude')
    const dirtyPreview = await dirtyService.preview('C:/repo')
    await expect(dirtyService.execute('C:/repo', {
      action: 'update-branch', fingerprint: dirtyPreview.fingerprint, message: '', includeUnstaged: false, baseBranch: 'master',
    })).rejects.toMatchObject({ code: 'dirty-workspace' })
    expect(dirty.spawn.mock.calls.every(call => !call[0].argv.includes('fetch'))).toBe(true)

    const missing = runtime([...previewResults(''), ...previewResults('')])
    const missingService = new RepositoryActionService(missing, 'claude')
    const missingPreview = await missingService.preview('C:/repo')
    await expect(missingService.execute('C:/repo', {
      action: 'update-branch', fingerprint: missingPreview.fingerprint, message: '', includeUnstaged: false,
    })).rejects.toMatchObject({ code: 'invalid-request' })
  })
})

describe('stopped operation resolution', () => {
  const head = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  async function rebaseDir(): Promise<string> {
    const gitDir = await mkdtemp(join(tmpdir(), 'dsh-claude-gitdir-'))
    await mkdir(join(gitDir, 'rebase-merge'))
    await writeFile(join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/feature/actions\n', 'utf8')
    return gitDir
  }

  it('continues the operation git is actually holding and pushes the rewritten branch', async () => {
    const gitDir = await rebaseDir()
    const fake = runtime([
      { stdout: `C:/repo\n${gitDir}\n` },
      { stdout: '' },
      { stdout: '' },
      { stdout: `${head}\n` },
      { stdout: 'feature/actions\n' },
      { stdout: 'origin/feature/actions\n' },
      { stdout: '' },
    ])
    const service = new RepositoryActionService(fake, 'claude')
    // No preview: a stopped rebase detaches HEAD, which the preview refuses.
    await expect(service.execute('C:/repo', {
      action: 'resolve-continue', fingerprint: '', message: '', includeUnstaged: false, push: true,
    })).resolves.toEqual({ commit: head, pushed: true })
    expect(fake.spawn.mock.calls[2]?.[0].argv).toEqual(['C:/bin/git.exe', '-c', 'core.editor=true', 'rebase', '--continue'])
    expect(fake.spawn.mock.calls[6]?.[0].argv).toEqual(['C:/bin/git.exe', 'push', '--force-with-lease'])
  })

  it('refuses to continue while paths are still unmerged', async () => {
    const gitDir = await rebaseDir()
    const fake = runtime([
      { stdout: `C:/repo\n${gitDir}\n` },
      { stdout: 'src/a.ts\n' },
    ])
    await expect(new RepositoryActionService(fake, 'claude').execute('C:/repo', {
      action: 'resolve-continue', fingerprint: '', message: '', includeUnstaged: false,
    })).rejects.toMatchObject({ code: 'unresolved-conflicts' })
  })

  it('reports the next commit that stops instead of failing the resume', async () => {
    const gitDir = await rebaseDir()
    const fake = runtime([
      { stdout: `C:/repo\n${gitDir}\n` },
      { stdout: '' },
      { stdout: '', exitCode: 1 },
      { stdout: 'src/b.ts\n' },
      { stdout: `${head}\n` },
    ])
    await expect(new RepositoryActionService(fake, 'claude').execute('C:/repo', {
      action: 'resolve-continue', fingerprint: '', message: '', includeUnstaged: false, push: true,
    })).resolves.toEqual({ commit: head, pushed: false, conflicts: ['src/b.ts'] })
  })

  it('aborts the operation and never pushes what it rolled back', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'dsh-claude-gitdir-'))
    await writeFile(join(gitDir, 'MERGE_HEAD'), `${head}\n`, 'utf8')
    const fake = runtime([
      { stdout: `C:/repo\n${gitDir}\n` },
      { stdout: '' },
      { stdout: `${head}\n` },
    ])
    await expect(new RepositoryActionService(fake, 'claude').execute('C:/repo', {
      action: 'resolve-abort', fingerprint: '', message: '', includeUnstaged: false, push: true,
    })).resolves.toEqual({ commit: head, pushed: false })
    expect(fake.spawn.mock.calls[1]?.[0].argv).toEqual(['C:/bin/git.exe', 'merge', '--abort'])
    expect(fake.spawn.mock.calls.every(call => !call[0].argv.includes('push'))).toBe(true)
  })

  it('refuses when git is holding no operation at all', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'dsh-claude-gitdir-'))
    const fake = runtime([{ stdout: `C:/repo\n${gitDir}\n` }])
    await expect(new RepositoryActionService(fake, 'claude').execute('C:/repo', {
      action: 'resolve-abort', fingerprint: '', message: '', includeUnstaged: false,
    })).rejects.toMatchObject({ code: 'no-operation' })
  })
})
