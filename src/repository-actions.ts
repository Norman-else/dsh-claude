import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { diffFuncnameArgs } from './diff-funcname.ts'
import { detectRepositoryOperation } from './repository-status.ts'

const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_PATCH_CHARS = 64 * 1024
const MAX_MESSAGE_CHARS = 512
const MAX_PR_TEXT_CHARS = 8 * 1024
const MAX_UNPUSHED_COMMITS = 20
const GIT_TIMEOUT_MS = 15_000
const REMOTE_TIMEOUT_MS = 60_000
const GENERATE_TIMEOUT_MS = 60_000
/** One cold `claude -p` per generation, so everything the subject line cannot
 *  use is cost: MCP servers (which `ask` already skips for the same reason,
 *  and which stall for as long as an unreachable one takes to give up) and the
 *  user's own hooks and settings. Project settings stay: a repository's commit
 *  conventions belong in the message. `--tools ''` keeps `--output-format`
 *  between it and the prompt -- both flags are variadic. */
const GENERATE_ARGUMENTS: readonly string[] = [
  '-p',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', 'project,local',
  '--tools', '', '--output-format', 'text',
]

type RepositoryActionRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
export type RepositoryActionKind = 'commit' | 'commit-push' | 'push' | 'create-pr' | 'merge-pr' | 'update-branch' | 'resolve-continue' | 'resolve-abort'
export type RepositoryMergeMethod = 'merge' | 'squash' | 'rebase'

interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly lossy: boolean
}

export interface RepositoryActionFile {
  readonly path: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
}

export interface RepositoryActionCommit {
  readonly hash: string
  readonly subject: string
}

export interface RepositoryActionPreview {
  readonly root: string
  readonly branch: string
  readonly head: string
  readonly fingerprint: string
  readonly files: readonly RepositoryActionFile[]
  readonly patch: string
  readonly truncated: boolean
  readonly hasStaged: boolean
  readonly hasUnstaged: boolean
  readonly hasUntracked: boolean
  readonly upstream?: string
  readonly unpushedCommits: readonly RepositoryActionCommit[]
  readonly unpushedTruncated: boolean
}

export interface RepositoryActionRequest {
  readonly action: RepositoryActionKind
  readonly fingerprint: string
  readonly message: string
  readonly includeUnstaged: boolean
  readonly prTitle?: string
  readonly prBody?: string
  readonly baseBranch?: string
  readonly draft?: boolean
  readonly mergeMethod?: RepositoryMergeMethod
  /** Push once `resolve-continue` finishes the operation it resumed. */
  readonly push?: boolean
}

export interface RepositoryActionResult {
  readonly commit: string
  readonly pushed: boolean
  readonly pullRequestUrl?: string
  /** Conflicted paths left in the working tree by an update-branch merge or
   *  rebase, or by the commit a resumed one stopped on next. */
  readonly conflicts?: readonly string[]
}

export class RepositoryActionError extends Error {
  readonly code: string
  readonly commit?: string

  constructor(code: string, message: string, commit?: string) {
    super(message)
    this.name = 'RepositoryActionError'
    this.code = code
    if (commit !== undefined) this.commit = commit
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

function safeText(value: string, maximum: number, label: string): string {
  const text = value.trim()
  if (text.length === 0 || text.length > maximum || /[\0\r]/u.test(text)) {
    throw new RepositoryActionError('invalid-request', `${label} is invalid.`)
  }
  return text
}

export function isProtectedWarpPath(path: string): boolean {
  return basename(path.replaceAll('\\', '/')).toLocaleLowerCase('en-US') === 'warp.md'
}

export function parseRepositoryActionStatus(output: string): readonly RepositoryActionFile[] {
  const files = new Map<string, RepositoryActionFile>()
  const records = output.includes('\0') ? output.split('\0') : output.split(/\r?\n/u)
  for (let position = 0; position < records.length; position += 1) {
    const line = records[position] ?? ''
    if (line.length < 4) continue
    const index = line[0] ?? ' '
    const worktree = line[1] ?? ' '
    let path = line.slice(3)
    const rename = path.lastIndexOf(' -> ')
    if (rename >= 0) path = path.slice(rename + 4)
    if (output.includes('\0') && (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C')) position += 1
    if (path.length === 0 || path.includes('\0') || isProtectedWarpPath(path)) continue
    files.set(path, {
      path,
      staged: index !== ' ' && index !== '?',
      unstaged: worktree !== ' ' && worktree !== '?',
      untracked: index === '?' && worktree === '?',
    })
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function conflictPaths(result: CommandResult): readonly string[] {
  if (result.exitCode !== 0 || result.lossy) return []
  return result.stdout.split(/\r?\n/u).filter(line => line.length > 0).slice(0, 100)
}

function fallbackCommitMessage(files: readonly RepositoryActionFile[]): string {
  if (files.length === 1) return `Update ${files[0]?.path ?? 'repository files'}`
  return `Update ${files.length} repository files`
}

function normalizedGeneratedMessage(value: string, fallback: string): string {
  const first = value.split(/\r?\n/u).map(line => line.trim()).find(Boolean)
  if (first === undefined) return fallback
  const message = first.replace(/^['"`]+|['"`]+$/gu, '').replace(/[\0\r\n]/gu, ' ').trim()
  return message.length === 0 || message.length > 72 ? fallback : message
}

function validPrUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function validPullRequestBody(value: string): boolean {
  const body = value.trim()
  const match = /^Summary:\s+([^\r\n]+)\r?\n\r?\nChanges:\s*\r?\n([\s\S]+)$/u.exec(body)
  const summary = match?.[1]?.trim()
  const changes = match?.[2]?.trim()
  if (summary === undefined || summary.length === 0 || changes === undefined || changes.length === 0) return false
  return !/^#{1,6}\s|^[A-Za-z][A-Za-z ]+:\s*$/mu.test(changes)
}

export class RepositoryActionService {
  readonly #runtime: RepositoryActionRuntime
  readonly #claudeExecutable: string
  readonly #invalidate: (cwd: string) => void
  #gitExecutable?: Promise<string>
  #ghExecutable?: Promise<string>
  #pending: Promise<unknown> = Promise.resolve()

  constructor(runtime: RepositoryActionRuntime, claudeExecutable: string, invalidate: (cwd: string) => void = () => {}) {
    this.#runtime = runtime
    this.#claudeExecutable = claudeExecutable
    this.#invalidate = invalidate
  }

  preview(cwd: string): Promise<RepositoryActionPreview> {
    return this.#preview(cwd)
  }

  async generateMessage(cwd: string, fingerprint: string): Promise<string> {
    const preview = await this.#preview(cwd)
    if (preview.fingerprint !== fingerprint) throw new RepositoryActionError('repository-changed', 'Repository changes have changed. Refresh the commit panel.')
    const fallback = fallbackCommitMessage(preview.files)
    const prompt = [
      'Write one concise English git commit subject (imperative mood, maximum 72 characters).',
      'Return only the subject without quotes, markdown, body, or explanation.',
      `Files: ${preview.files.map(file => file.path).join(', ')}`,
      `Diff:\n${preview.patch.slice(0, 24 * 1024)}`,
    ].join('\n')
    try {
      const result = await this.#run(this.#claudeExecutable, GENERATE_ARGUMENTS.concat(prompt), preview.root, GENERATE_TIMEOUT_MS)
      return result.exitCode === 0 && !result.lossy ? normalizedGeneratedMessage(result.stdout, fallback) : fallback
    } catch {
      return fallback
    }
  }

  execute(cwd: string, request: RepositoryActionRequest): Promise<RepositoryActionResult> {
    const operation = this.#pending.then(() => this.#execute(cwd, request))
    this.#pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  async #execute(cwd: string, request: RepositoryActionRequest): Promise<RepositoryActionResult> {
    // A stopped rebase leaves a detached HEAD and an unmerged tree, which the
    // preview refuses outright -- so resuming one has to run before it.
    if (request.action === 'resolve-continue' || request.action === 'resolve-abort') return this.#resolve(cwd, request.action, request.push === true)
    const before = await this.#preview(cwd)
    if (before.fingerprint !== request.fingerprint) throw new RepositoryActionError('repository-changed', 'Repository changes have changed. Refresh the commit panel.')
    if (request.action === 'push') {
      const git = await this.#git()
      try {
        await this.#push(git, before.root, before.branch)
      } catch (error) {
        throw new RepositoryActionError('push-failed', error instanceof Error ? error.message : 'Git push failed.')
      }
      this.#invalidate(before.root)
      return { commit: before.head, pushed: true }
    }
    if (request.action === 'merge-pr') {
      const method = request.mergeMethod
      if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
        throw new RepositoryActionError('invalid-request', 'The merge method is invalid.')
      }
      let gh: string
      try {
        gh = await this.#gh()
      } catch (error) {
        throw new RepositoryActionError('gh-unavailable', error instanceof Error ? error.message : 'GitHub CLI is unavailable.')
      }
      const merged = await this.#run(gh, ['pr', 'merge', `--${method}`], before.root, REMOTE_TIMEOUT_MS)
      if (merged.exitCode !== 0 || merged.lossy) {
        const reason = merged.stderr.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0).at(-1)
        throw new RepositoryActionError('merge-failed', reason === undefined || reason.length === 0 ? 'The pull request could not be merged.' : reason)
      }
      this.#invalidate(before.root)
      return { commit: before.head, pushed: true }
    }
    if (request.action === 'update-branch') {
      const base = safeText(request.baseBranch ?? '', 512, 'Base branch')
      if (before.files.length > 0) {
        throw new RepositoryActionError('dirty-workspace', 'Commit or stash workspace changes before updating the branch.')
      }
      const method = request.mergeMethod ?? 'rebase'
      if (method !== 'merge' && method !== 'rebase') throw new RepositoryActionError('invalid-request', 'Update branch supports merge or rebase.')
      const git = await this.#git()
      await this.#mustRun(git, ['fetch', 'origin', '--', base], before.root, REMOTE_TIMEOUT_MS, 'fetch-failed', 'Git could not fetch the base branch.')
      const merged = await this.#run(git, method === 'rebase' ? ['rebase', '--', `origin/${base}`] : ['merge', '--no-edit', '--', `origin/${base}`], before.root, REMOTE_TIMEOUT_MS)
      if (merged.exitCode !== 0 || merged.lossy) {
        const conflicts = conflictPaths(await this.#run(git, ['diff', '--name-only', '--diff-filter=U', '--'], before.root, GIT_TIMEOUT_MS))
        if (conflicts.length === 0) {
          await this.#run(git, [method, '--abort'], before.root, GIT_TIMEOUT_MS).catch(() => undefined)
          throw new RepositoryActionError('merge-failed', `Git could not ${method} the base branch.`)
        }
        // Leave the conflicted tree in place: resolving it is the next step.
        this.#invalidate(before.root)
        return { commit: before.head, pushed: false, conflicts }
      }
      const mergedHead = (await this.#mustRun(git, ['rev-parse', 'HEAD'], before.root, GIT_TIMEOUT_MS, 'merge-failed', 'The updated commit could not be verified.')).stdout.trim()
      try {
        // A rebase rewrites the branch, so the push must replace the remote ref; --force-with-lease still refuses if someone else pushed.
        await this.#push(git, before.root, before.branch, method === 'rebase')
      } catch (error) {
        throw new RepositoryActionError('push-failed', error instanceof Error ? error.message : 'Git push failed.', mergedHead)
      }
      this.#invalidate(before.root)
      return { commit: mergedHead, pushed: true }
    }
    const message = safeText(request.message, MAX_MESSAGE_CHARS, 'Commit message')
    if (before.files.length === 0 && request.action !== 'create-pr') {
      throw new RepositoryActionError('nothing-to-commit', 'There are no changes to commit.')
    }
    const git = await this.#git()
    let oid = before.head
    if (before.files.length > 0) {
      await this.#rejectStagedWarp(git, before.root)
      if (request.includeUnstaged) {
        const paths = before.files.filter(file => file.unstaged || file.untracked).map(file => file.path)
        if (paths.length > 0) await this.#mustRun(git, ['add', '--', ...paths], before.root, GIT_TIMEOUT_MS, 'stage-failed', 'Changes could not be staged.')
      }
      await this.#rejectStagedWarp(git, before.root)
      const staged = await this.#run(git, ['diff', '--cached', '--quiet', '--exit-code', '--'], before.root, GIT_TIMEOUT_MS)
      if (staged.exitCode === 0) throw new RepositoryActionError('nothing-to-commit', 'There are no staged changes to commit.')
      if (staged.exitCode !== 1) throw new RepositoryActionError('repository-unavailable', 'The staged changes could not be verified.')
      await this.#mustRun(git, ['commit', '-m', message, '--'], before.root, GIT_TIMEOUT_MS, 'commit-failed', 'Git commit failed.')
      oid = (await this.#mustRun(git, ['rev-parse', 'HEAD'], before.root, GIT_TIMEOUT_MS, 'commit-failed', 'The new commit could not be verified.')).stdout.trim()
      this.#invalidate(before.root)
      if (request.action === 'commit') return { commit: oid, pushed: false }
    }
    try {
      await this.#push(git, before.root, before.branch)
    } catch (error) {
      throw new RepositoryActionError('push-failed', error instanceof Error ? error.message : 'Git push failed.', oid)
    }
    this.#invalidate(before.root)
    if (request.action === 'commit-push') return { commit: oid, pushed: true }
    const title = safeText(request.prTitle ?? message, 256, 'Pull request title')
    const body = safeText(request.prBody ?? '', MAX_PR_TEXT_CHARS, 'Pull request description')
    if (!validPullRequestBody(body)) {
      throw new RepositoryActionError('invalid-pr-description', 'Pull request description must contain only Summary and Changes sections.', oid)
    }
    let gh: string
    try {
      gh = await this.#gh()
    } catch (error) {
      throw new RepositoryActionError('gh-unavailable', error instanceof Error ? error.message : 'GitHub CLI is unavailable.', oid)
    }
    const args = ['pr', 'create', '--title', title, '--body', body]
    if (request.draft !== false) args.push('--draft')
    if (request.baseBranch !== undefined) args.push('--base', safeText(request.baseBranch, 512, 'Base branch'))
    const created = await this.#run(gh, args, before.root, REMOTE_TIMEOUT_MS)
    const url = created.exitCode === 0 && !created.lossy ? validPrUrl(created.stdout) : undefined
    if (url === undefined) throw new RepositoryActionError('pr-failed', 'The pull request could not be created.', oid)
    return { commit: oid, pushed: true, pullRequestUrl: url }
  }

  /** Finishes or discards the merge, rebase, cherry-pick or revert git is
   *  waiting on. The operation is read from the git dir rather than taken from
   *  the caller: `--continue` and `--abort` are only safe against the one that
   *  is actually in progress. */
  async #resolve(cwd: string, action: 'resolve-continue' | 'resolve-abort', push: boolean): Promise<RepositoryActionResult> {
    const git = await this.#git()
    const paths = await this.#mustRun(git, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir'], cwd, GIT_TIMEOUT_MS, 'not-repository', 'The session directory is not a Git repository.')
    const [rootValue, gitDirValue] = paths.stdout.split(/\r?\n/u)
    const root = (rootValue ?? '').trim()
    const gitDir = (gitDirValue ?? '').trim()
    if (root.length === 0 || gitDir.length === 0) throw new RepositoryActionError('repository-unavailable', 'Repository state is unavailable.')
    const state = await detectRepositoryOperation(gitDir)
    if (state === undefined) throw new RepositoryActionError('no-operation', 'No merge, rebase, cherry-pick or revert is in progress.')
    const operation = state.operation
    if (action === 'resolve-abort') {
      await this.#mustRun(git, [operation, '--abort'], root, GIT_TIMEOUT_MS, 'abort-failed', `Git could not abort the ${operation}.`)
      this.#invalidate(root)
      return { commit: await this.#head(git, root), pushed: false }
    }
    const unmerged = conflictPaths(await this.#run(git, ['diff', '--name-only', '--diff-filter=U', '--'], root, GIT_TIMEOUT_MS))
    if (unmerged.length > 0) throw new RepositoryActionError('unresolved-conflicts', 'Resolve and stage every conflicted file before continuing.')
    // `core.editor=true` accepts the prepared message: nothing here can host an
    // editor, and a rebase that opens one would hang until the timeout.
    const continued = await this.#run(git, ['-c', 'core.editor=true', operation, '--continue'], root, REMOTE_TIMEOUT_MS)
    this.#invalidate(root)
    if (continued.exitCode !== 0 || continued.lossy) {
      // A rebase replays commit by commit, so the next one can stop on its own
      // conflicts: that is progress, not a failure, and it keeps the panel open.
      const next = conflictPaths(await this.#run(git, ['diff', '--name-only', '--diff-filter=U', '--'], root, GIT_TIMEOUT_MS))
      if (next.length > 0) return { commit: await this.#head(git, root), pushed: false, conflicts: next }
      const reason = continued.stderr.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0).at(-1)
      throw new RepositoryActionError('continue-failed', reason === undefined || reason.length === 0 ? `Git could not continue the ${operation}.` : reason)
    }
    const head = await this.#head(git, root)
    if (!push) return { commit: head, pushed: false }
    const branch = await this.#run(git, ['symbolic-ref', '--quiet', '--short', 'HEAD'], root, GIT_TIMEOUT_MS)
    if (branch.exitCode !== 0 || branch.lossy) throw new RepositoryActionError('detached-head', 'The finished operation left a detached HEAD, so nothing was pushed.', head)
    try {
      // A rebase rewrote the branch, so its push has to replace the remote ref.
      await this.#push(git, root, branch.stdout.trim(), operation === 'rebase')
    } catch (error) {
      throw new RepositoryActionError('push-failed', error instanceof Error ? error.message : 'Git push failed.', head)
    }
    this.#invalidate(root)
    return { commit: head, pushed: true }
  }

  async #head(git: string, root: string): Promise<string> {
    const head = await this.#run(git, ['rev-parse', 'HEAD'], root, GIT_TIMEOUT_MS)
    return head.exitCode === 0 && !head.lossy ? head.stdout.trim() : ''
  }

  async #preview(cwd: string): Promise<RepositoryActionPreview> {
    const git = await this.#git()
    const rootResult = await this.#mustRun(git, ['rev-parse', '--path-format=absolute', '--show-toplevel'], cwd, GIT_TIMEOUT_MS, 'not-repository', 'The session directory is not a Git repository.')
    const root = rootResult.stdout.trim()
    const funcname = await diffFuncnameArgs()
    const [branchResult, headResult, statusResult, stagedPatch, unstagedPatch] = await Promise.all([
      this.#run(git, ['symbolic-ref', '--quiet', '--short', 'HEAD'], root, GIT_TIMEOUT_MS),
      this.#run(git, ['rev-parse', 'HEAD'], root, GIT_TIMEOUT_MS),
      this.#run(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, GIT_TIMEOUT_MS),
      this.#run(git, [...funcname, 'diff', '--cached', '--no-ext-diff', '--no-color', '--unified=3', '--', ':(exclude)WARP.md', ':(exclude)**/WARP.md'], root, GIT_TIMEOUT_MS, MAX_OUTPUT_BYTES),
      this.#run(git, [...funcname, 'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', ':(exclude)WARP.md', ':(exclude)**/WARP.md'], root, GIT_TIMEOUT_MS, MAX_OUTPUT_BYTES),
    ])
    if (branchResult.exitCode !== 0) throw new RepositoryActionError('detached-head', 'A detached HEAD cannot be committed from this panel.')
    if (headResult.exitCode !== 0 || statusResult.exitCode !== 0 || statusResult.lossy) throw new RepositoryActionError('repository-unavailable', 'Repository state is unavailable.')
    const files = parseRepositoryActionStatus(statusResult.stdout)
    const patch = `${stagedPatch.stdout}${stagedPatch.stdout.length > 0 && unstagedPatch.stdout.length > 0 ? '\n' : ''}${unstagedPatch.stdout}`.slice(0, MAX_PATCH_CHARS)
    const branch = branchResult.stdout.trim()
    const head = headResult.stdout.trim()
    const fingerprint = createHash('sha256').update([head, branch, statusResult.stdout, stagedPatch.stdout, unstagedPatch.stdout].join('\0')).digest('hex')
    const upstreamResult = await this.#run(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root, GIT_TIMEOUT_MS)
    const upstream = upstreamResult.exitCode === 0 && !upstreamResult.lossy ? upstreamResult.stdout.trim() : undefined
    const logResult = await this.#run(git, [
      'log', '--format=%H%x09%s', `-n`, String(MAX_UNPUSHED_COMMITS + 1), upstream === undefined ? 'HEAD' : '@{upstream}..HEAD', '--',
    ], root, GIT_TIMEOUT_MS)
    const commitLines = logResult.exitCode === 0 && !logResult.lossy
      ? logResult.stdout.split(/\r?\n/u).filter(line => line.includes('\t'))
      : []
    const unpushedCommits = commitLines.slice(0, MAX_UNPUSHED_COMMITS).flatMap(line => {
      const tab = line.indexOf('\t')
      const hash = line.slice(0, tab)
      return /^[0-9a-f]{40}$/iu.test(hash) ? [{ hash, subject: line.slice(tab + 1).slice(0, 140) }] : []
    })
    return {
      root,
      branch,
      head,
      fingerprint,
      files,
      patch,
      truncated: stagedPatch.lossy || unstagedPatch.lossy || stagedPatch.stdout.length + unstagedPatch.stdout.length > MAX_PATCH_CHARS,
      hasStaged: files.some(file => file.staged),
      hasUnstaged: files.some(file => file.unstaged),
      hasUntracked: files.some(file => file.untracked),
      ...(upstream === undefined ? {} : { upstream }),
      unpushedCommits,
      unpushedTruncated: commitLines.length > MAX_UNPUSHED_COMMITS,
    }
  }

  async #rejectStagedWarp(git: string, cwd: string): Promise<void> {
    const staged = await this.#run(git, ['diff', '--cached', '--name-only', '--'], cwd, GIT_TIMEOUT_MS)
    if (staged.exitCode !== 0 || staged.lossy) throw new RepositoryActionError('repository-unavailable', 'Staged files could not be verified.')
    if (staged.stdout.split(/\r?\n/u).some(path => path.length > 0 && isProtectedWarpPath(path))) {
      throw new RepositoryActionError('protected-warp-file', 'WARP.md files cannot be committed. Unstage them before continuing.')
    }
  }

  async #push(git: string, cwd: string, branch: string, forceWithLease = false): Promise<void> {
    const upstream = await this.#run(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd, GIT_TIMEOUT_MS)
    const args = upstream.exitCode === 0 ? ['push', ...(forceWithLease ? ['--force-with-lease'] : [])] : ['push', '--set-upstream', 'origin', branch]
    await this.#mustRun(git, args, cwd, REMOTE_TIMEOUT_MS, 'push-failed', 'Git push failed.')
  }

  #git(): Promise<string> {
    this.#gitExecutable ??= this.#runtime.resolveExecutable('git')
    return this.#gitExecutable
  }

  #gh(): Promise<string> {
    this.#ghExecutable ??= this.#runtime.resolveExecutable('gh').catch(() => { throw new RepositoryActionError('gh-unavailable', 'GitHub CLI is unavailable.') })
    return this.#ghExecutable
  }

  async #mustRun(executable: string, args: readonly string[], cwd: string, timeoutMs: number, code: string, message: string): Promise<CommandResult> {
    const result = await this.#run(executable, args, cwd, timeoutMs)
    if (result.exitCode !== 0 || result.lossy) throw new RepositoryActionError(code, message)
    return result
  }

  #run(executable: string, args: readonly string[], cwd: string, timeoutMs: number, maxBytes = MAX_OUTPUT_BYTES): Promise<CommandResult> {
    return collect(this.#runtime.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: MAX_OUTPUT_BYTES } },
      graceMs: 1_000,
      signal: AbortSignal.timeout(timeoutMs),
      env: {},
    }))
  }
}
