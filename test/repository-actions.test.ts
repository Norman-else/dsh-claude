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
    expect(command).toMatchObject({ cwd: 'C:/repo', env: {}, argv: ['C:/bin/claude.exe', '-p', '--tools', '', '--output-format', 'text', expect.any(String)] })
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
