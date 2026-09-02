import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { RepositorySetupError, RepositorySetupService, parseWorktreeBranches, type RepositorySetupStage } from '../src/repository-setup.ts'

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

function runtime(results: Array<{ stdout?: string; exitCode?: number; stderr?: string }>) {
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
    // Real spawn cannot run in a directory that is gone; a fake that answers
    // anyway hides every command this code issues against a removed worktree.
    if (typeof spec.cwd === 'string' && !existsSync(spec.cwd)) {
      throw Object.assign(new Error(`spawn ENOENT: ${spec.cwd}`), { code: 'ENOENT' })
    }
    const result = results.shift()
    if (result === undefined) throw new Error('unexpected command')
    return handle(result.stdout ?? '', result.exitCode, result.stderr ?? '')
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

  it('fetches and prunes remote references before listing branches', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '' },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: 'origin/main \norigin/feature/b \n' },
    ])
    await expect(new RepositorySetupService(fake, { leasePath, worktreeRoot }).refreshBranches(root)).resolves.toEqual({
      root,
      current: 'main',
      dirty: false,
      branches: ['main'],
      remoteBranches: ['origin/feature/b', 'origin/main'],
    })
    expect(fake.spawn.mock.calls.map(call => call[0].argv)).toEqual([
      ['/bin/git', 'rev-parse', '--path-format=absolute', '--show-toplevel'],
      ['/bin/git', '-c', 'credential.interactive=never', 'fetch', '--all', '--prune'],
      ['/bin/git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      ['/bin/git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      ['/bin/git', 'for-each-ref', '--format=%(refname:short) %(symref)', 'refs/remotes'],
    ])
  })

  it('fails a refresh the remote rejected instead of returning stale branches', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '', exitCode: 128, stderr: 'fatal: could not read Username' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot })
    const failure = await service.refreshBranches(root).catch((error: unknown) => error)
    expect(failure).toMatchObject<Partial<RepositorySetupError>>({ code: 'fetch-failed' })
    expect((failure as Error).message).not.toContain('could not read Username')
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
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot, cleanupGraceMs: 0 })
    const result = await service.setup(root, 'main', true)
    expect(result).toMatchObject({ mode: 'worktree', root, branch: expect.stringMatching(/^claude\/main-/), leaseId: expect.any(String) })
    expect(result.path.startsWith(worktreeRoot)).toBe(true)
    await mkdir(result.path, { recursive: true })
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
    expect(fake.spawn.mock.calls[6]?.[0].argv).toEqual(['/bin/git', 'worktree', 'remove', '--force', '--', result.path])
    expect(fake.spawn.mock.calls[7]?.[0].argv).toEqual(['/bin/git', 'branch', '-D', '--', result.branch])
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

  it('names the worktree directory after the repository and branch, flattened and case-kept', async () => {
    // The workspace list shows this directory name, so a timestamp there means
    // telling two checkouts apart requires opening a session.
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot })
    const result = await service.setup(root, 'main', true, 'feature/PSOS-5683')
    expect(result.path).toBe(join(worktreeRoot, `${basename(root).toLowerCase()}-feature-PSOS-5683`))
  })

  it('steps a colliding worktree directory aside instead of failing the add', async () => {
    // Without the timestamp, a directory a crash left behind owns the name.
    const { root, leasePath, worktreeRoot } = await roots()
    await mkdir(join(worktreeRoot, `${basename(root).toLowerCase()}-PSOS-5683`), { recursive: true })
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot })
    const result = await service.setup(root, 'main', true, 'PSOS-5683')
    expect(result.path).toBe(join(worktreeRoot, `${basename(root).toLowerCase()}-PSOS-5683-2`))
  })

  it('names a generated branch after the composer draft, skipping a name already taken', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'claude/fix-login-redirect\nmain\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const summarizeBranch = vi.fn(async () => 'fix-login-redirect')
    const stages: RepositorySetupStage[] = []
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot, summarizeBranch })
    const result = await service.setup(root, 'main', true, undefined, stage => stages.push(stage), '修复登录跳转的问题')
    expect(result.branch).toBe('claude/fix-login-redirect-2')
    expect(summarizeBranch).toHaveBeenCalledWith('修复登录跳转的问题')
    expect(stages).toContain('summarizing')
  })

  it('keeps the timestamped name when there is no draft, no summary, or a failing summarizer', async () => {
    for (const [summarizeBranch, intent] of [
      [vi.fn(async () => 'ignored'), undefined],
      [vi.fn(async () => undefined), 'ship it'],
      [vi.fn(() => Promise.reject(new Error('no executable'))), 'ship it'],
    ] as const) {
      const { root, leasePath, worktreeRoot } = await roots()
      const fake = runtime([
        { stdout: `${root}\n` },
        { stdout: '# branch.head main\n' },
        { stdout: 'main\n' },
        { stdout: '' },
        { stdout: '' },
        { stdout: '' },
      ])
      const service = new RepositorySetupService(fake, { leasePath, worktreeRoot, summarizeBranch })
      const result = await service.setup(root, 'main', true, undefined, () => {}, intent)
      expect(result.branch).toMatch(/^claude\/main-/u)
      expect(summarizeBranch).toHaveBeenCalledTimes(intent === undefined ? 0 : 1)
    }
  })

  it('reuses an existing explicitly named branch after pruning stale registrations', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'PSOS-5694\nmain\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot })
    const result = await service.setup(root, 'main', true, 'PSOS-5694')
    expect(result).toMatchObject({ mode: 'worktree', branch: 'PSOS-5694' })
    expect(fake.spawn.mock.calls[5]?.[0].argv).toEqual(['/bin/git', 'worktree', 'prune'])
    expect(fake.spawn.mock.calls[6]?.[0].argv).toEqual(['/bin/git', 'worktree', 'add', '--', result.path, 'PSOS-5694'])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases[0]).toMatchObject({ branch: 'PSOS-5694', pluginGeneratedBranch: false })
  })

  it('surfaces the git error when the worktree cannot be created', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { exitCode: 128, stderr: "Preparing worktree\nfatal: a branch named 'PSOS-5694' already exists\n" },
    ])
    await expect(new RepositorySetupService(fake, { leasePath, worktreeRoot }).setup(root, 'main', true, 'PSOS-5694'))
      .rejects.toMatchObject<Partial<RepositorySetupError>>({
        code: 'worktree-failed',
        message: "Git could not create the worktree: fatal: a branch named 'PSOS-5694' already exists",
      })
  })

  it('preserves an explicitly named branch after removing its Worktree', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const fake = runtime([
      { stdout: `${root}\n` },
      { stdout: '# branch.head main\n' },
      { stdout: 'main\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot, cleanupGraceMs: 0 })
    const result = await service.setup(root, 'main', true, 'feature/user-owned')
    await mkdir(result.path, { recursive: true })
    await service.bindLease(result.leaseId ?? '', 'session-explicit')
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases[0]).toMatchObject({
      branch: 'feature/user-owned',
      pluginGeneratedBranch: false,
    })

    await service.cleanupOrphans([])

    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toEqual([])
    expect(fake.spawn.mock.calls[6]?.[0].argv).toEqual(['/bin/git', 'worktree', 'remove', '--force', '--', result.path])
    // A branch the user named is theirs; only generated ones are deleted.
    expect(fake.spawn.mock.calls).toHaveLength(7)
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

  // Deleting the workspace is the user saying they are done with it, so the
  // sweep no longer inspects the tree and no longer keeps a dirty worktree.
  it('removes a worktree with uncommitted changes once its workspace is gone', async () => {
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
    const result = await service.setup(root, 'main', true)
    await mkdir(result.path, { recursive: true })
    await writeFile(join(result.path, 'local.txt'), 'uncommitted\n')
    await service.bindLease(result.leaseId ?? '', 'session-2')

    await service.cleanupOrphans([])

    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toEqual([])
    const cleanup = fake.spawn.mock.calls.slice(6).map(call => call[0].argv)
    expect(cleanup).toContainEqual(['/bin/git', 'worktree', 'remove', '--force', '--', result.path])
    // The tree is never inspected: nothing decides to keep it.
    expect(cleanup.flat()).not.toContain('status')
  })

  it('archives every session in the worktree before removing it', async () => {
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
    const result = await service.setup(root, 'main', true)
    await mkdir(result.path, { recursive: true })
    const removedAtArchive: string[][][] = []
    const archive = vi.fn(async (path: string) => {
      removedAtArchive.push(fake.spawn.mock.calls.map(call => call[0].argv).filter(argv => argv.includes('remove')))
      expect(path).toBe(result.path)
    })

    await service.cleanupOrphans([], archive)

    expect(archive).toHaveBeenCalledWith(result.path)
    // The Host rebuilds a deleted workspace from session headers, so archiving
    // has to land before the directory does.
    expect(removedAtArchive[0]).toEqual([])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toEqual([])
  })

  it('sweeps a worktree directory no lease and no workspace claims', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const stranded = join(worktreeRoot, 'premier-store-os-20260828T085557Z-10bc6d37')
    const claimed = join(worktreeRoot, 'still-a-workspace')
    await mkdir(join(stranded, '.idea'), { recursive: true })
    await mkdir(claimed, { recursive: true })

    await new RepositorySetupService(runtime([]), { leasePath, worktreeRoot, cleanupGraceMs: 0 })
      .cleanupOrphans([claimed])

    expect(existsSync(stranded)).toBe(false)
    expect(existsSync(claimed)).toBe(true)
    expect(root.length).toBeGreaterThan(0)
  })

  it('archives the sessions of a swept directory whose lease is gone', async () => {
    const { leasePath, worktreeRoot } = await roots()
    const stranded = join(worktreeRoot, 'premier-store-os-20260828T063549Z-288afc2b')
    await mkdir(stranded, { recursive: true })
    const archive = vi.fn(async () => {})

    await new RepositorySetupService(runtime([]), { leasePath, worktreeRoot, cleanupGraceMs: 0 })
      .cleanupOrphans([], archive)

    // Without this the directory goes and its sessions stay in the sidebar.
    expect(archive).toHaveBeenCalledWith(stranded)
    expect(existsSync(stranded)).toBe(false)
  })

  it('keeps a directory whose lease has not been written yet', async () => {
    const { leasePath, worktreeRoot } = await roots()
    const fresh = join(worktreeRoot, 'mid-creation')
    await mkdir(fresh, { recursive: true })

    await new RepositorySetupService(runtime([]), { leasePath, worktreeRoot }).cleanupOrphans([])

    expect(existsSync(fresh)).toBe(true)
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

  // Spawning in a directory that is gone throws ENOENT, which used to leave
  // the lease behind forever; every command has to run from the repository.
  it('drops a lease and prunes Git metadata when the worktree directory is gone', async () => {
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
    const result = await service.setup(root, 'main', true)
    await service.cleanupOrphans([])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toEqual([])
    expect(fake.spawn.mock.calls.every(call => call[0].cwd === root)).toBe(true)
    expect(fake.spawn.mock.calls.map(call => call[0].argv)).toContainEqual(['/bin/git', 'worktree', 'prune'])
    expect(result.path.length).toBeGreaterThan(0)
  })
})

describe('merged cleanup', () => {
  it('removes a merged plugin worktree, its branch, and its lease', async () => {
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
    const service = new RepositorySetupService(fake, { leasePath, worktreeRoot })
    const result = await service.setup(root, 'main', true)
    await mkdir(result.path, { recursive: true })
    await expect(service.cleanupMerged(result.path, 'main')).resolves.toEqual({ mode: 'worktree', root, branch: result.branch })
    const argv = fake.spawn.mock.calls.map(call => call[0].argv)
    expect(argv).toContainEqual(['/bin/git', 'worktree', 'remove', '--', result.path])
    expect(argv).toContainEqual(['/bin/git', 'branch', '-D', '--', result.branch])
    expect(JSON.parse(await readFile(leasePath, 'utf8')).leases).toEqual([])
  })

  it('switches a plain checkout back to base and refuses dirty trees', async () => {
    const { root, leasePath, worktreeRoot } = await roots()
    const clean = runtime([
      { stdout: '' },
      { stdout: `${root}\n` },
      { stdout: 'feature/done\n' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '' },
    ])
    await expect(new RepositorySetupService(clean, { leasePath, worktreeRoot }).cleanupMerged(root, 'main'))
      .resolves.toEqual({ mode: 'checkout', root, branch: 'feature/done' })
    const argv = clean.spawn.mock.calls.map(call => call[0].argv)
    expect(argv).toContainEqual(['/bin/git', 'switch', '--', 'main'])
    expect(argv).toContainEqual(['/bin/git', 'branch', '-D', '--', 'feature/done'])

    const dirty = runtime([{ stdout: ' M src/a.ts\n' }])
    await expect(new RepositorySetupService(dirty, { leasePath, worktreeRoot }).cleanupMerged(root, 'main'))
      .rejects.toMatchObject<Partial<RepositorySetupError>>({ code: 'dirty-workspace' })
  })
})
