import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { RepositorySetupError, RepositorySetupService, parseWorktreeBranches } from '../src/repository-setup.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function handle(stdout: string, exitCode = 0, stderr = '', lossy = false): SubprocessHandle {
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: async () => true,
  }
}

function runtime(results: Array<{ stdout?: string; exitCode?: number }>) {
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => {
    const result = results.shift()
    if (result === undefined) throw new Error('unexpected command')
    return handle(result.stdout ?? '', result.exitCode)
  })
  return { spawn, resolveExecutable: vi.fn(async () => '/bin/git') }
}

async function roots() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-setup-'))
  temporary.push(root)
  return { root, leasePath: join(root, 'state', 'leases.json'), worktreeRoot: join(root, 'worktrees') }
}

describe('repository setup service', () => {
  it('parses occupied branches from porcelain worktree output', () => {
    expect(parseWorktreeBranches('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /other\nbranch refs/heads/feature/x\n')).toEqual(new Map([
      ['main', '/repo'], ['feature/x', '/other'],
    ]))
  })

  it('lists sorted local branches with current and dirty state', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n? untracked.txt\n' },
      { stdout: 'zeta\nmain\nfeature/a\n' },
      { stdout: 'origin/HEAD refs/remotes/origin/main\norigin/feature/b \norigin/main \n' },
    ])
    await expect(new RepositorySetupService(fake, { leasePath, worktreeRoot }).listBranches(root)).resolves.toEqual({
      root,
      current: 'main',
      dirty: true,
      branches: ['feature/a', 'main', 'zeta'],
      remoteBranches: ['origin/feature/b', 'origin/main'],
    })
    expect(fake.spawn.mock.calls.map(call => call[0].argv)).toEqual([
      ['/bin/git', 'rev-parse', '--path-format=absolute', '--show-toplevel'],
      ['/bin/git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      ['/bin/git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      ['/bin/git', 'for-each-ref', '--format=%(refname:short) %(symref)', 'refs/remotes'],
    ])
    expect(fake.spawn.mock.calls.every(call => call[0].env !== undefined && Object.keys(call[0].env).length === 0)).toBe(true)
  })

  it('rejects dirty checkout and a branch occupied by another worktree', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const dirty = new RepositorySetupService(runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n1 .M N... file.ts\n' },
      { stdout: 'main\nfeature/a\n' },
      { stdout: '' },
    ]), { leasePath, worktreeRoot })
    await expect(dirty.setup(root, 'feature/a', false)).rejects.toMatchObject<Partial<RepositorySetupError>>({ code: 'dirty-workspace' })

    const occupied = new RepositorySetupService(runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\nfeature/a\n' },
      { stdout: '' },
      { stdout: `worktree ${root}\nbranch refs/heads/main\n\nworktree /other\nbranch refs/heads/feature/a\n` },
    ]), { leasePath, worktreeRoot })
    await expect(occupied.setup(root, 'feature/a', false)).rejects.toMatchObject<Partial<RepositorySetupError>>({ code: 'branch-occupied' })
  })

  it('creates, binds, and removes a clean plugin-owned worktree and its generated branch', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot, cleanupGraceMs: 0 })
    const result = await service.setup(root, 'main', true)
    expect(result).toMatchObject({ mode: 'worktree', root, branch: expect.stringMatching(/^claude\/main-/), leaseId: expect.any(String) })
    expect(result.path.startsWith(worktreeRoot)).toBe(true)
    await service.bindLease(result.leaseId ?? '', 'session-1')
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases[0]).toMatchObject({
      path: result.path,
      sessionId: 'session-1',
      pluginGeneratedBranch: true,
    })
    await service.cleanupOrphans([])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toEqual([])
    expect(fake.spawn.mock.calls[4]?.[0].argv).toEqual([
      '/bin/git', '-c', 'credential.interactive=never', 'fetch', '--all', '--prune',
    ])
    const worktreeAdd = fake.spawn.mock.calls[5]?.[0].argv
    expect(worktreeAdd?.slice(0, 4)).toEqual(['/bin/git', 'worktree', 'add', '-b'])
    expect(worktreeAdd?.at(-1)).toBe('refs/heads/main')
    expect(fake.spawn.mock.calls[7]?.[0].argv).toEqual(['/bin/git', 'worktree', 'remove', '--', result.path])
    expect(fake.spawn.mock.calls[8]?.[0].argv).toEqual(['/bin/git', 'branch', '-D', '--', result.branch])
  })

  it('uses a configured prefix for generated branches and preserves an explicit branch name', async () => {
    const first = await roots()
    const generatedRuntime = runtime([
      { stdout: `${first.root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const generated = await new RepositorySetupService(generatedRuntime, {
      leasePath: first.leasePath,
      worktreeRoot: first.worktreeRoot,
      branchPrefix: async () => 'team/claude',
    }).setup(first.root, 'main', true)
    expect(generated.branch).toMatch(/^team\/claude\/main-/)

    const second = await roots()
    const explicitRuntime = runtime([
      { stdout: `${second.root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const explicit = await new RepositorySetupService(explicitRuntime, {
      leasePath: second.leasePath,
      worktreeRoot: second.worktreeRoot,
      branchPrefix: async () => 'ignored',
    }).setup(second.root, 'main', true, 'feature/exact-name')
    expect(explicit.branch).toBe('feature/exact-name')
    expect(explicitRuntime.spawn.mock.calls[5]?.[0].argv).toContain('feature/exact-name')
  })

  it('preserves an explicitly named branch after removing its clean Worktree', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot, cleanupGraceMs: 0 })
    const result = await service.setup(root, 'main', true, 'feature/user-owned')
    await service.bindLease(result.leaseId ?? '', 'session-explicit')
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases[0]).toMatchObject({
      branch: 'feature/user-owned',
      pluginGeneratedBranch: false,
    })

    await service.cleanupOrphans([])

    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toEqual([])
    expect(fake.spawn.mock.calls[7]?.[0].argv).toEqual(['/bin/git', 'worktree', 'remove', '--', result.path])
    expect(fake.spawn.mock.calls).toHaveLength(8)
  })

  it('creates a Worktree directly from a remote-tracking ref', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: 'origin/feature/remote \n' },
      { stdout: '' },
      { stdout: '' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot })
    const result = await service.setup(root, 'origin/feature/remote', true)
    expect(result.branch).toMatch(/^claude\/origin-feature-remote-/)
    expect(fake.spawn.mock.calls[5]?.[0].argv.at(-1)).toBe('refs/remotes/origin/feature/remote')
  })

  it('stops Worktree creation when remote reference refresh fails', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: 'origin/main \n' },
      { exitCode: 1 },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot })
    await expect(service.setup(root, 'origin/main', true)).rejects.toMatchObject<Partial<RepositorySetupError>>({ code: 'fetch-failed' })
    expect(fake.spawn.mock.calls).toHaveLength(5)
    expect(fake.spawn.mock.calls.flatMap(call => call[0].argv)).not.toContain('worktree')
  })

  it('creates, reuses, and protects local branches for remote checkout', async () => {
    const createdPaths = await roots()
    const createdRuntime = runtime([
      { stdout: `${createdPaths.root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: 'origin/feature/remote \n' },
      { stdout: '' },
    ])
    const created = await new RepositorySetupService(createdRuntime, createdPaths)
      .setup(createdPaths.root, 'origin/feature/remote', false)
    expect(created).toMatchObject({ mode: 'checkout', branch: 'feature/remote', path: createdPaths.root })
    expect(createdRuntime.spawn.mock.calls[4]?.[0].argv).toEqual([
      '/bin/git', 'switch', '--track', '-c', 'feature/remote', 'refs/remotes/origin/feature/remote',
    ])

    const reusedPaths = await roots()
    const reusedRuntime = runtime([
      { stdout: `${reusedPaths.root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'feature/remote\nmain\n' },
      { stdout: 'origin/feature/remote \n' },
      { stdout: 'origin/feature/remote\n' },
      { stdout: `worktree ${reusedPaths.root}\nbranch refs/heads/main\n` },
      { stdout: '' },
    ])
    const reused = await new RepositorySetupService(reusedRuntime, reusedPaths)
      .setup(reusedPaths.root, 'origin/feature/remote', false)
    expect(reused.branch).toBe('feature/remote')
    expect(reusedRuntime.spawn.mock.calls[6]?.[0].argv).toEqual(['/bin/git', 'switch', '--', 'feature/remote'])

    const conflictPaths = await roots()
    const conflictRuntime = runtime([
      { stdout: `${conflictPaths.root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'feature/remote\nmain\n' },
      { stdout: 'origin/feature/remote \n' },
      { stdout: 'upstream/feature/remote\n' },
    ])
    await expect(new RepositorySetupService(conflictRuntime, conflictPaths)
      .setup(conflictPaths.root, 'origin/feature/remote', false))
      .rejects.toMatchObject<Partial<RepositorySetupError>>({ code: 'branch-tracking-conflict' })
  })

  it('retains dirty worktree leases during cleanup', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '? local.txt\n' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot, cleanupGraceMs: 0 })
    const result = await service.setup(root, 'main', true)
    await service.bindLease(result.leaseId ?? '', 'session-2')
    await service.cleanupOrphans([])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toHaveLength(1)
    expect(fake.spawn.mock.calls).toHaveLength(7)
    expect(result.path.length).toBeGreaterThan(0)
  })

  it('retains workspace-referenced and freshly created worktree leases', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const fresh = new RepositorySetupService(fake, { leasePath, worktreeRoot })
    const result = await fresh.setup(root, 'main', true)
    // A just-created lease sits inside the registration grace period.
    await fresh.cleanupOrphans([])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toHaveLength(1)
    // A referenced lease is retained even with the grace period elapsed, and
    // the path comparison tolerates case and separator spelling differences.
    const aged = new RepositorySetupService(runtime([]), { leasePath, worktreeRoot, cleanupGraceMs: 0 })
    await aged.cleanupOrphans([result.path.toUpperCase()])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toHaveLength(1)
    expect(fake.spawn.mock.calls).toHaveLength(6)
  })

  it('drops a lease and prunes Git metadata when the worktree directory is gone', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '', exitCode: 128 },
      { stdout: '' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot, cleanupGraceMs: 0 })
    await service.setup(root, 'main', true)
    await service.cleanupOrphans([])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toEqual([])
    expect(fake.spawn.mock.calls.at(-1)?.[0].argv).toEqual(['/bin/git', 'worktree', 'prune'])
  })
})
