import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const MAX_OUTPUT_BYTES = 128 * 1024
const GIT_TIMEOUT_MS = 10_000
const GIT_FETCH_TIMEOUT_MS = 60_000
const MAX_PATH_CHARS = 4_096
const MAX_BRANCH_CHARS = 512
const LEASE_SCHEMA_VERSION = 1
// ponytail: grace only needs to outlive the worktree-create -> workspace-register
// hop (seconds); two minutes keeps deletion feeling prompt while staying safe.
const CLEANUP_GRACE_MS = 2 * 60_000

type RepositorySetupRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly lossy: boolean
}

export interface RepositoryBranchList {
  readonly root: string
  readonly current?: string
  readonly dirty: boolean
  readonly branches: readonly string[]
  readonly remoteBranches: readonly string[]
}

export type RepositorySetupStage = 'inspecting' | 'fetching' | 'creating-worktree' | 'saving-worktree' | 'switching-branch'
export type RepositorySetupProgress = (stage: RepositorySetupStage) => void

export interface RepositorySetupResult {
  readonly mode: 'checkout' | 'worktree'
  readonly root: string
  readonly path: string
  readonly branch: string
  readonly leaseId?: string
}

export interface RepositoryCleanupResult {
  readonly mode: 'checkout' | 'worktree'
  readonly root: string
  readonly branch: string
}

interface WorktreeLease {
  readonly id: string
  readonly root: string
  readonly path: string
  readonly branch: string
  readonly createdAt: string
  readonly pluginGeneratedBranch: boolean
  readonly sessionId?: string
}

interface LeaseDocument {
  readonly schemaVersion: typeof LEASE_SCHEMA_VERSION
  readonly leases: readonly WorktreeLease[]
}

export interface RepositorySetupServiceOptions {
  readonly leasePath?: string
  readonly worktreeRoot?: string
  readonly branchPrefix?: () => Promise<string>
  readonly cleanupGraceMs?: number
}

export class RepositorySetupError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RepositorySetupError'
    this.code = code
  }
}

async function collect(handle: SubprocessHandle): Promise<CommandResult> {
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    exitCode: outcome.exitCode,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    lossy: stdout?.lossy === true || stderr?.lossy === true,
  }
}

function safePath(value: string): string {
  if (value.length === 0 || value.length > MAX_PATH_CHARS || !isAbsolute(value) || value.includes('\0')) {
    throw new RepositorySetupError('invalid-path', 'The workspace path is invalid.')
  }
  return resolve(value)
}

function safeBranch(value: string): string {
  if (value.length === 0 || value.length > MAX_BRANCH_CHARS || value.trim() !== value || /[\0\r\n]/u.test(value)) {
    throw new RepositorySetupError('invalid-branch', 'The branch name is invalid.')
  }
  return value
}

function parseCurrentBranch(value: string): string | undefined {
  const branch = value.trim()
  return branch.length === 0 || branch === 'HEAD' ? undefined : branch
}

export function parseWorktreeBranches(value: string): ReadonlyMap<string, string> {
  const occupied = new Map<string, string>()
  let path: string | undefined
  for (const line of `${value}\n`.split(/\r?\n/u)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/') && path !== undefined) {
      occupied.set(line.slice('branch refs/heads/'.length), path)
    } else if (line.length === 0) path = undefined
  }
  return occupied
}

function slug(value: string, fallback: string): string {
  const normalized = value.toLocaleLowerCase('en-US').replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return normalized.slice(0, 48) || fallback
}

/** Comparable form for path identity: resolved, forward slashes, case-folded
 *  so Windows drive-letter or case spelling differences cannot hide a match. */
function comparablePath(value: string): string {
  return resolve(value).replaceAll('\\', '/').toLocaleLowerCase('en-US')
}

function pathExists(value: string): Promise<boolean> {
  return stat(value).then(() => true, () => false)
}

function lease(value: unknown): WorktreeLease | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || typeof input.root !== 'string' || typeof input.path !== 'string'
    || typeof input.branch !== 'string' || typeof input.createdAt !== 'string'
    || (input.pluginGeneratedBranch !== undefined && typeof input.pluginGeneratedBranch !== 'boolean')
    || (input.sessionId !== undefined && typeof input.sessionId !== 'string')) return undefined
  return {
    id: input.id,
    root: input.root,
    path: input.path,
    branch: input.branch,
    createdAt: input.createdAt,
    pluginGeneratedBranch: input.pluginGeneratedBranch === true,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  }
}

export class RepositorySetupService {
  readonly #runtime: RepositorySetupRuntime
  readonly #leasePath: string
  readonly #worktreeRoot: string
  readonly #branchPrefix: () => Promise<string>
  readonly #cleanupGraceMs: number
  #gitPath: Promise<string> | undefined
  #pending: Promise<unknown> = Promise.resolve()

  constructor(runtime: RepositorySetupRuntime, options: RepositorySetupServiceOptions = {}) {
    this.#runtime = runtime
    this.#leasePath = options.leasePath ?? dshHomePath('plugins', 'dsh-claude', 'worktrees.json')
    this.#worktreeRoot = options.worktreeRoot ?? dshHomePath('plugins', 'dsh-claude', 'worktrees')
    this.#branchPrefix = options.branchPrefix ?? (async () => 'claude')
    this.#cleanupGraceMs = options.cleanupGraceMs ?? CLEANUP_GRACE_MS
  }

  async listBranches(cwd: string): Promise<RepositoryBranchList> {
    const git = await this.#git()
    const root = await this.#repositoryRoot(git, safePath(cwd))
    const [status, refs, remoteRefs] = await Promise.all([
      this.#run(git, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], root),
      this.#run(git, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], root),
      this.#run(git, ['for-each-ref', '--format=%(refname:short) %(symref)', 'refs/remotes'], root),
    ])
    if (status.exitCode !== 0 || status.lossy || refs.exitCode !== 0 || refs.lossy
      || remoteRefs.exitCode !== 0 || remoteRefs.lossy) {
      throw new RepositorySetupError('repository-unavailable', 'The repository state is unavailable.')
    }
    const current = status.stdout.split(/\r?\n/u)
      .find(line => line.startsWith('# branch.head '))
      ?.slice('# branch.head '.length)
    const branches = refs.stdout.split(/\r?\n/u).filter(Boolean).sort((left, right) => left.localeCompare(right))
    const remoteBranches = remoteRefs.stdout.split(/\r?\n/u)
      .map(line => line.trim().split(/\s+/u))
      .filter(parts => parts[0] !== undefined && parts[0].length > 0 && parts.length === 1)
      .map(parts => parts[0]!)
      .sort((left, right) => left.localeCompare(right))
    const currentBranch = current === undefined ? undefined : parseCurrentBranch(current)
    return {
      root,
      ...(currentBranch === undefined ? {} : { current: currentBranch }),
      dirty: status.stdout.split(/\r?\n/u).some(line => line.length > 0 && !line.startsWith('# ')),
      branches,
      remoteBranches,
    }
  }

  async setup(
    cwd: string,
    branchValue: string,
    useWorktree: boolean,
    explicitBranchName?: string,
    progress: RepositorySetupProgress = () => {},
  ): Promise<RepositorySetupResult> {
    progress('inspecting')
    const branch = safeBranch(branchValue)
    const info = await this.listBranches(cwd)
    const local = info.branches.includes(branch)
    const remote = info.remoteBranches.includes(branch)
    if (!local && !remote) {
      throw new RepositorySetupError('branch-not-found', 'The selected local or remote-tracking branch does not exist.')
    }
    const requestedBranch = explicitBranchName === undefined ? undefined : safeBranch(explicitBranchName)
    if (useWorktree) {
      return this.#createWorktree(
        info.root,
        branch,
        local ? `refs/heads/${branch}` : `refs/remotes/${branch}`,
        requestedBranch,
        requestedBranch !== undefined && info.branches.includes(requestedBranch),
        progress,
      )
    }
    progress('switching-branch')
    return !local && remote ? this.#checkoutRemote(info, branch) : this.#checkout(info, branch)
  }

  /** Tear down a merged branch: remove a plugin worktree (and its lease and
   *  branch), or switch a plain checkout back to the base branch and delete
   *  the merged branch. Refuses dirty trees. */
  async cleanupMerged(pathValue: string, baseBranch: string): Promise<RepositoryCleanupResult> {
    const path = safePath(pathValue)
    const base = safeBranch(baseBranch)
    const git = await this.#git()
    const status = await this.#run(git, ['status', '--porcelain=v1', '--untracked-files=normal'], path)
    if (status.exitCode !== 0 || status.lossy) throw new RepositorySetupError('repository-unavailable', 'The repository state is unavailable.')
    if (status.stdout.trim().length > 0) throw new RepositorySetupError('dirty-workspace', 'Commit or stash workspace changes before cleaning up.')
    const lease = (await this.#readLeases()).find(item => comparablePath(item.path) === comparablePath(path))
    if (lease !== undefined) {
      return this.#serialize(async () => {
        const removed = await this.#run(git, ['worktree', 'remove', '--', lease.path], lease.root)
        if (removed.exitCode !== 0) throw new RepositorySetupError('worktree-remove-failed', 'Git could not remove the worktree.')
        await this.#run(git, ['branch', '-D', '--', lease.branch], lease.root).catch(() => undefined)
        const current = await this.#readLeases()
        await this.#writeLeases(current.filter(item => item.id !== lease.id))
        return { mode: 'worktree' as const, root: lease.root, branch: lease.branch }
      })
    }
    const root = await this.#repositoryRoot(git, path)
    const head = await this.#run(git, ['symbolic-ref', '--quiet', '--short', 'HEAD'], root)
    const branch = head.exitCode === 0 ? head.stdout.trim() : ''
    if (branch.length === 0 || branch === base) throw new RepositorySetupError('nothing-to-clean', 'The checkout is already on the base branch.')
    const switched = await this.#run(git, ['switch', '--', base], root)
    if (switched.exitCode !== 0) throw new RepositorySetupError('checkout-failed', 'Git could not switch to the base branch.')
    await this.#run(git, ['branch', '-D', '--', branch], root).catch(() => undefined)
    await this.#run(git, ['pull', '--ff-only'], root, GIT_FETCH_TIMEOUT_MS).catch(() => undefined)
    return { mode: 'checkout', root, branch }
  }

  bindLease(leaseId: string, sessionId: string): Promise<void> {
    if (leaseId.length === 0 || leaseId.length > 128 || sessionId.length === 0 || sessionId.length > 1_024) {
      return Promise.reject(new RepositorySetupError('invalid-lease', 'The worktree lease is invalid.'))
    }
    return this.#serialize(async () => {
      const leases = await this.#readLeases()
      const index = leases.findIndex(item => item.id === leaseId)
      if (index < 0) throw new RepositorySetupError('lease-not-found', 'The worktree lease no longer exists.')
      const existing = leases[index]
      if (existing === undefined) throw new RepositorySetupError('lease-not-found', 'The worktree lease no longer exists.')
      leases[index] = { ...existing, sessionId }
      await this.#writeLeases(leases)
    })
  }

  /** Reconcile leases against the set of directories still referenced by a
   *  workspace: an unreferenced lease's clean worktree is removed. Fresh
   *  leases are retained for a grace period so a worktree created moments ago
   *  cannot be swept before its workspace registration lands, and dirty
   *  worktrees are always retained to avoid losing uncommitted work. */
  cleanupOrphans(activePaths: readonly string[]): Promise<void> {
    const active = new Set(activePaths.map(comparablePath))
    return this.#serialize(async () => {
      const leases = await this.#readLeases()
      const retained: WorktreeLease[] = []
      let changed = false
      const git = await this.#git()
      const now = Date.now()
      for (const item of leases) {
        const age = now - Date.parse(item.createdAt)
        if (active.has(comparablePath(item.path)) || !(age >= this.#cleanupGraceMs)) {
          retained.push(item)
          continue
        }
        try {
          const status = await this.#run(git, ['status', '--porcelain=v1', '--untracked-files=normal'], item.path)
          if (status.exitCode !== 0 || status.lossy) {
            if (await pathExists(item.path)) {
              retained.push(item)
            } else {
              // The directory is already gone; drop the lease and let Git
              // forget the stale worktree registration.
              await this.#run(git, ['worktree', 'prune'], item.root).catch(() => undefined)
              changed = true
            }
            continue
          }
          if (status.stdout.trim().length > 0) {
            retained.push(item)
            continue
          }
          const removed = await this.#run(git, ['worktree', 'remove', '--', item.path], item.root)
          if (removed.exitCode !== 0) {
            retained.push(item)
            continue
          }
          if (item.pluginGeneratedBranch) {
            await this.#run(git, ['branch', '-D', '--', item.branch], item.root).catch(() => undefined)
          }
          changed = true
        } catch {
          if (await pathExists(item.root)) retained.push(item)
          else changed = true // the repository itself is gone; the lease is dead weight
        }
      }
      if (changed) await this.#writeLeases(retained)
    })
  }

  async #checkoutRemote(info: RepositoryBranchList, remoteBranch: string): Promise<RepositorySetupResult> {
    const separator = remoteBranch.indexOf('/')
    if (separator <= 0 || separator === remoteBranch.length - 1) {
      throw new RepositorySetupError('invalid-branch', 'The remote-tracking branch name is invalid.')
    }
    const localBranch = safeBranch(remoteBranch.slice(separator + 1))
    if (info.branches.includes(localBranch)) {
      const git = await this.#git()
      const upstream = await this.#run(git, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${localBranch}`], info.root)
      if (upstream.exitCode !== 0 || upstream.lossy) {
        throw new RepositorySetupError('repository-unavailable', 'The local branch tracking state is unavailable.')
      }
      if (upstream.stdout.trim() !== remoteBranch) {
        throw new RepositorySetupError('branch-tracking-conflict', `The local branch ${localBranch} does not track ${remoteBranch}.`)
      }
      return this.#checkout(info, localBranch)
    }
    if (info.dirty) throw new RepositorySetupError('dirty-workspace', 'Commit or stash workspace changes before switching branches.')
    const git = await this.#git()
    const switched = await this.#run(git, ['switch', '--track', '-c', localBranch, `refs/remotes/${remoteBranch}`], info.root)
    if (switched.exitCode !== 0) throw new RepositorySetupError('checkout-failed', 'Git could not create the local tracking branch.')
    return { mode: 'checkout', root: info.root, path: info.root, branch: localBranch }
  }

  async #checkout(info: RepositoryBranchList, branch: string): Promise<RepositorySetupResult> {
    if (info.current !== branch) {
      if (info.dirty) throw new RepositorySetupError('dirty-workspace', 'Commit or stash workspace changes before switching branches.')
      const git = await this.#git()
      const worktrees = await this.#run(git, ['worktree', 'list', '--porcelain'], info.root)
      if (worktrees.exitCode !== 0 || worktrees.lossy) throw new RepositorySetupError('repository-unavailable', 'Worktree state is unavailable.')
      const occupiedPath = parseWorktreeBranches(worktrees.stdout).get(branch)
      if (occupiedPath !== undefined && resolve(occupiedPath) !== info.root) {
        throw new RepositorySetupError('branch-occupied', 'The selected branch is already checked out in another worktree.')
      }
      const switched = await this.#run(git, ['switch', '--', branch], info.root)
      if (switched.exitCode !== 0) throw new RepositorySetupError('checkout-failed', 'Git could not switch to the selected branch.')
    }
    return { mode: 'checkout', root: info.root, path: info.root, branch }
  }

  async #createWorktree(
    root: string,
    baseBranch: string,
    baseRef: string,
    explicitBranchName: string | undefined,
    reuseExistingBranch: boolean,
    progress: RepositorySetupProgress,
  ): Promise<RepositorySetupResult> {
    const git = await this.#git()
    progress('fetching')
    const fetched = await this.#run(
      git,
      ['-c', 'credential.interactive=never', 'fetch', '--all', '--prune'],
      root,
      GIT_FETCH_TIMEOUT_MS,
    )
    if (fetched.exitCode !== 0 || fetched.lossy) {
      throw new RepositorySetupError('fetch-failed', 'Git could not refresh remote references before creating the worktree.')
    }
    const suffix = randomUUID().slice(0, 8)
    const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
    const branch = explicitBranchName ?? `${safeBranch(await this.#branchPrefix())}/${slug(baseBranch, 'branch')}-${stamp}-${suffix}`
    const path = join(this.#worktreeRoot, `${slug(basename(root), 'repository')}-${stamp}-${suffix}`)
    progress('creating-worktree')
    await mkdir(this.#worktreeRoot, { recursive: true })
    // A stale registration from a deleted worktree directory would keep the
    // existing branch "checked out" and block reusing it.
    if (reuseExistingBranch) await this.#run(git, ['worktree', 'prune'], root).catch(() => undefined)
    const created = await this.#run(
      git,
      reuseExistingBranch ? ['worktree', 'add', '--', path, branch] : ['worktree', 'add', '-b', branch, path, baseRef],
      root,
    )
    if (created.exitCode !== 0) {
      const detail = created.stderr.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0).at(-1)
      throw new RepositorySetupError('worktree-failed', detail === undefined ? 'Git could not create the worktree.' : `Git could not create the worktree: ${detail}`)
    }
    const item: WorktreeLease = {
      id: randomUUID(),
      root,
      path,
      branch,
      createdAt: new Date().toISOString(),
      pluginGeneratedBranch: explicitBranchName === undefined,
    }
    progress('saving-worktree')
    try {
      await this.#serialize(async () => {
        const leases = await this.#readLeases()
        await this.#writeLeases([...leases, item])
      })
    } catch (error) {
      await this.#run(git, ['worktree', 'remove', '--force', '--', path], root).catch(() => undefined)
      if (!reuseExistingBranch) await this.#run(git, ['branch', '-D', '--', branch], root).catch(() => undefined)
      throw error
    }
    return { mode: 'worktree', root, path, branch, leaseId: item.id }
  }

  async #repositoryRoot(git: string, cwd: string): Promise<string> {
    const result = await this.#run(git, ['rev-parse', '--path-format=absolute', '--show-toplevel'], cwd)
    const root = result.stdout.trim()
    if (result.exitCode !== 0 || result.lossy || root.length === 0 || !isAbsolute(root)) {
      throw new RepositorySetupError('not-repository', 'The workspace is not a Git repository.')
    }
    return resolve(root)
  }

  #git(): Promise<string> {
    this.#gitPath ??= this.#runtime.resolveExecutable('git')
    return this.#gitPath
  }


  async #run(executable: string, args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<CommandResult> {
    return collect(this.#runtime.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_OUTPUT_BYTES },
      },
      graceMs: 1_000,
      signal: AbortSignal.timeout(timeoutMs),
      env: {},
    }))
  }

  async #readLeases(): Promise<WorktreeLease[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#leasePath, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      const input = parsed as Record<string, unknown>
      if (input.schemaVersion !== LEASE_SCHEMA_VERSION || !Array.isArray(input.leases)) return []
      return input.leases.map(lease).filter((item): item is WorktreeLease => item !== undefined)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async #writeLeases(leases: readonly WorktreeLease[]): Promise<void> {
    await mkdir(resolve(this.#leasePath, '..'), { recursive: true })
    const temporary = `${this.#leasePath}.${process.pid}.${randomUUID()}.tmp`
    const document: LeaseDocument = { schemaVersion: LEASE_SCHEMA_VERSION, leases }
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.#leasePath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation)
    this.#pending = result.then(() => undefined, () => undefined)
    return result
  }
}
