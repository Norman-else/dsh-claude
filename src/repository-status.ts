import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_DIFF_BYTES = 256 * 1024
const GIT_TIMEOUT_MS = 5_000
const GH_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 5_000
const MAX_TEXT_CHARS = 1_024

export type RepositoryCheckState = 'passing' | 'pending' | 'failing' | 'none'
export type RepositoryReviewState = 'approved' | 'changes-requested' | 'review-required' | 'none'

export interface RepositoryPullRequestStatus {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: 'open' | 'closed' | 'merged'
  readonly draft: boolean
  readonly review: RepositoryReviewState
  readonly checks: RepositoryCheckState
  readonly mergeState?: string
  readonly author?: string
  readonly createdAt?: string
  readonly baseBranch?: string
}

export interface RepositoryDiffStatus {
  readonly additions: number
  readonly deletions: number
  readonly files: number
  readonly patch?: string
  readonly truncated: boolean
}

export interface RepositoryStatus {
  readonly status: 'ready' | 'not-repository' | 'unavailable'
  readonly cwd: string
  readonly root?: string
  readonly branch?: string
  readonly detached?: boolean
  readonly worktree?: boolean
  readonly dirty?: boolean
  readonly remote?: string
  readonly pullRequest?: RepositoryPullRequestStatus
  readonly diff?: RepositoryDiffStatus
}

type RepositoryRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly lossy: boolean
}

function bounded(value: string): string {
  return value.trim().slice(0, MAX_TEXT_CHARS)
}

async function collect(handle: SubprocessHandle): Promise<CommandResult> {
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  return {
    exitCode: outcome.exitCode,
    stdout: stdout?.text ?? '',
    lossy: stdout?.lossy === true,
  }
}

async function run(
  runtime: RepositoryRuntime,
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxBytes = MAX_OUTPUT_BYTES,
): Promise<CommandResult> {
  const signal = AbortSignal.timeout(timeoutMs)
  return collect(runtime.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes },
      stderr: { maxBytes: MAX_OUTPUT_BYTES },
    },
    graceMs: 1_000,
    signal,
    env: {},
  }))
}

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
}

export function parseGitStatus(output: string): { branch?: string; detached: boolean; dirty: boolean } {
  let branch: string | undefined
  let detached = false
  let dirty = false
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('# branch.head ')) {
      const head = bounded(line.slice('# branch.head '.length))
      if (head === '(detached)') detached = true
      else if (head.length > 0 && head !== '(unknown)') branch = head
      continue
    }
    if (line.length > 0 && !line.startsWith('# ')) dirty = true
  }
  return { ...(branch === undefined ? {} : { branch }), detached, dirty }
}

export function parseDiffNumstat(value: string): Omit<RepositoryDiffStatus, 'patch' | 'truncated'> {
  let additions = 0
  let deletions = 0
  let files = 0
  for (const line of value.split(/\r?\n/u)) {
    if (line.length === 0) continue
    const [added, deleted] = line.split('\t')
    files += 1
    if (added !== undefined && /^\d+$/u.test(added)) additions += Number(added)
    if (deleted !== undefined && /^\d+$/u.test(deleted)) deletions += Number(deleted)
  }
  return { additions, deletions, files }
}

export function parseGitHubRemote(value: string): string | undefined {
  const remote = bounded(value)
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu.exec(remote)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return `${match[1]}/${match[2]}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function aggregateChecks(value: unknown): RepositoryCheckState {
  if (!Array.isArray(value) || value.length === 0) return 'none'
  let pending = false
  for (const item of value) {
    const check = record(item)
    if (check === undefined) continue
    const conclusion = typeof check.conclusion === 'string' ? check.conclusion.toUpperCase() : undefined
    const status = typeof check.status === 'string' ? check.status.toUpperCase() : undefined
    const state = typeof check.state === 'string' ? check.state.toUpperCase() : undefined
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(conclusion ?? state ?? '')) return 'failing'
    if (status !== undefined && status !== 'COMPLETED') pending = true
    if (['PENDING', 'EXPECTED'].includes(state ?? '')) pending = true
  }
  return pending ? 'pending' : 'passing'
}

function reviewState(value: unknown): RepositoryReviewState {
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes-requested'
  if (value === 'REVIEW_REQUIRED') return 'review-required'
  return 'none'
}

export function parsePullRequest(value: unknown): RepositoryPullRequestStatus | undefined {
  const input = record(value)
  if (input === undefined
    || !Number.isSafeInteger(input.number)
    || Number(input.number) <= 0
    || typeof input.title !== 'string'
    || typeof input.url !== 'string') return undefined
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined
  const rawState = typeof input.state === 'string' ? input.state.toUpperCase() : ''
  const state = input.mergedAt !== undefined && input.mergedAt !== null
    ? 'merged'
    : rawState === 'OPEN' ? 'open' : rawState === 'CLOSED' ? 'closed' : undefined
  if (state === undefined) return undefined
  return {
    number: Number(input.number),
    title: bounded(input.title),
    url: url.href,
    state,
    draft: input.isDraft === true,
    review: reviewState(input.reviewDecision),
    checks: aggregateChecks(input.statusCheckRollup),
    ...(typeof input.mergeStateStatus === 'string'
      ? { mergeState: bounded(input.mergeStateStatus) }
      : {}),
    ...(typeof record(input.author)?.login === 'string'
      ? { author: bounded(String(record(input.author)?.login)) }
      : {}),
    ...(typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt))
      ? { createdAt: new Date(input.createdAt).toISOString() }
      : {}),
    ...(typeof input.baseRefName === 'string' && bounded(input.baseRefName).length > 0
      ? { baseBranch: bounded(input.baseRefName) }
      : {}),
  }
}

export class RepositoryStatusService {
  readonly #runtime: RepositoryRuntime
  readonly #cacheTtlMs: number
  readonly #cache = new Map<string, { expiresAt: number; value: Promise<RepositoryStatus> }>()
  readonly #lastReady = new Map<string, RepositoryStatus>()
  #gitExecutable?: Promise<string>
  #ghExecutable?: Promise<string | undefined>

  constructor(runtime: RepositoryRuntime, cacheTtlMs = CACHE_TTL_MS) {
    this.#runtime = runtime
    this.#cacheTtlMs = cacheTtlMs
  }

  inspect(cwd: string): Promise<RepositoryStatus> {
    const current = this.#cache.get(cwd)
    if (current !== undefined && current.expiresAt > Date.now()) return current.value
    const value = this.#inspect(cwd).then(next => this.#stabilize(cwd, next))
    this.#cache.set(cwd, { expiresAt: Date.now() + this.#cacheTtlMs, value })
    void value.catch(() => this.#cache.delete(cwd))
    return value
  }

  dispose(): void {
    this.#cache.clear()
    this.#lastReady.clear()
  }

  #stabilize(cwd: string, next: RepositoryStatus): RepositoryStatus {
    const previous = this.#lastReady.get(cwd)
    if (next.status !== 'ready') return previous ?? next
    const sameCheckout = previous?.status === 'ready'
      && previous.root === next.root
      && previous.branch === next.branch
    const stable = sameCheckout
      ? {
          ...next,
          ...(next.pullRequest === undefined && previous.pullRequest !== undefined ? { pullRequest: previous.pullRequest } : {}),
          ...(next.pullRequest === undefined && previous.pullRequest !== undefined && previous.diff !== undefined
            ? { diff: previous.diff }
            : next.diff === undefined && previous.diff !== undefined ? { diff: previous.diff } : {}),
        }
      : next
    this.#lastReady.set(cwd, stable)
    return stable
  }

  async #git(): Promise<string> {
    this.#gitExecutable ??= this.#runtime.resolveExecutable('git')
    return this.#gitExecutable
  }

  async #gh(): Promise<string | undefined> {
    this.#ghExecutable ??= this.#runtime.resolveExecutable('gh').catch(() => undefined)
    return this.#ghExecutable
  }

  async #inspect(cwd: string): Promise<RepositoryStatus> {
    const safeCwd = bounded(cwd)
    let git: string
    try {
      git = await this.#git()
    } catch {
      return { status: 'unavailable', cwd: safeCwd }
    }
    try {
      const paths = await run(this.#runtime, git, [
        'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir',
      ], cwd, GIT_TIMEOUT_MS)
      if (paths.exitCode !== 0) return { status: 'not-repository', cwd: safeCwd }
      const [rootValue, gitDirValue, commonDirValue] = paths.stdout.split(/\r?\n/u)
      const root = bounded(rootValue ?? '')
      const gitDir = bounded(gitDirValue ?? '')
      const commonDir = bounded(commonDirValue ?? '')
      if (root.length === 0 || gitDir.length === 0 || commonDir.length === 0) return { status: 'unavailable', cwd: safeCwd }
      const statusResult = await run(this.#runtime, git, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'], cwd, GIT_TIMEOUT_MS)
      if (statusResult.exitCode !== 0) return { status: 'unavailable', cwd: safeCwd }
      const status = parseGitStatus(statusResult.stdout)
      const remoteResult = await run(this.#runtime, git, ['remote', 'get-url', 'origin'], cwd, GIT_TIMEOUT_MS)
      const remote = remoteResult.exitCode === 0 ? parseGitHubRemote(remoteResult.stdout) : undefined
      const pullRequest = status.branch === undefined || remote === undefined
        ? undefined
        : await this.#pullRequest(cwd, remote, status.branch)
      const diffBase = pullRequest?.baseBranch === undefined
        ? 'HEAD'
        : await this.#mergeBase(cwd, git, pullRequest.baseBranch) ?? 'HEAD'
      const diff = status.dirty || diffBase !== 'HEAD'
        ? await this.#diff(cwd, git, diffBase)
        : { additions: 0, deletions: 0, files: 0, truncated: false }
      return {
        status: 'ready',
        cwd: safeCwd,
        root,
        ...status,
        worktree: normalizedPath(gitDir) !== normalizedPath(commonDir),
        ...(remote === undefined ? {} : { remote }),
        ...(pullRequest === undefined ? {} : { pullRequest }),
        ...(diff === undefined ? {} : { diff }),
      }
    } catch {
      return { status: 'unavailable', cwd: safeCwd }
    }
  }

  async #mergeBase(cwd: string, git: string, baseBranch: string): Promise<string | undefined> {
    try {
      const result = await run(this.#runtime, git, ['merge-base', 'HEAD', `refs/remotes/origin/${baseBranch}`], cwd, GIT_TIMEOUT_MS)
      if (result.exitCode !== 0 || result.lossy) return undefined
      const oid = bounded(result.stdout)
      return /^[0-9a-f]{40}$/iu.test(oid) ? oid : undefined
    } catch {
      return undefined
    }
  }

  async #diff(cwd: string, git: string, base: string): Promise<RepositoryDiffStatus | undefined> {
    try {
      const numstat = await run(this.#runtime, git, ['diff', '--no-ext-diff', '--numstat', base, '--'], cwd, GIT_TIMEOUT_MS)
      if (numstat.exitCode !== 0 || numstat.lossy) return undefined
      const summary = parseDiffNumstat(numstat.stdout)
      const patch = await run(this.#runtime, git, ['diff', '--no-ext-diff', '--no-color', '--unified=3', base, '--'], cwd, GIT_TIMEOUT_MS, MAX_DIFF_BYTES)
      if (patch.exitCode !== 0) return { ...summary, truncated: true }
      return {
        ...summary,
        ...(patch.lossy ? {} : { patch: patch.stdout }),
        truncated: patch.lossy,
      }
    } catch {
      return undefined
    }
  }

  async #pullRequest(cwd: string, repository: string, branch: string): Promise<RepositoryPullRequestStatus | undefined> {
    const gh = await this.#gh()
    if (gh === undefined) return undefined
    try {
      const result = await run(this.#runtime, gh, [
        'pr', 'view', branch,
        '--repo', repository,
        '--json', 'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,mergedAt,statusCheckRollup,author,createdAt,baseRefName',
      ], cwd, GH_TIMEOUT_MS)
      if (result.exitCode !== 0) return undefined
      return parsePullRequest(JSON.parse(result.stdout))
    } catch {
      return undefined
    }
  }
}
