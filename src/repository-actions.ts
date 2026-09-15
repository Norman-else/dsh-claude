import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { diffFuncnameArgs } from './diff-funcname.ts'
import { detectRepositoryOperation } from './repository-status.ts'

const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_PATCH_CHARS = 64 * 1024
const MAX_MESSAGE_CHARS = 2048
const MAX_PR_TEXT_CHARS = 8 * 1024
const MAX_UNPUSHED_COMMITS = 20
/** What one generation shows the model: the whole patch when it fits, the
 *  head of it otherwise, and the prompt says which. */
const MAX_GENERATE_PATCH_CHARS = 48 * 1024
const MAX_SUBJECT_CHARS = 72
/** A body is for the reader skimming `git log`, not a change list: past this
 *  many bullets it stops being read, so the rest are dropped. */
const MAX_BODY_BULLETS = 4
/** Past this the first line is not a subject at all; under it, a subject a
 *  few characters over what the prompt asked for is the user's to trim. */
const MAX_SUBJECT_KEPT_CHARS = 120
const MAX_PR_TITLE_CHARS = 100
const MAX_RECENT_SUBJECTS = 10
const MAX_PR_COMMITS = 50
const GIT_TIMEOUT_MS = 15_000
const REMOTE_TIMEOUT_MS = 60_000
const GENERATE_TIMEOUT_MS = 60_000
/** One cold `claude -p` per generation, so everything the subject line cannot
 *  use is cost: MCP servers (which `ask` already skips for the same reason,
 *  and which stall for as long as an unreachable one takes to give up) and the
 *  user's own hooks and settings. Project settings stay: a repository's commit
 *  conventions belong in the message. The prompt itself goes in on stdin:
 *  a 48 KB diff on argv is past what Windows lets a process be started with
 *  (ENAMETOOLONG, and the fallback subject where a message should be).
 *
 *  Sonnet rather than the session's default: describing a diff needs no
 *  frontier model, but telling three unrelated changes apart in one diff is
 *  where haiku starts to blur them, and sonnet costs only a second or two
 *  more. Extended thinking is off (see {@link GENERATE_ENV}): the naming call
 *  in prompts.ts measured it as most of a ten-second run. */
const GENERATE_ARGUMENTS: readonly string[] = [
  '-p',
  '--model', 'sonnet',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', 'project,local',
  '--tools', '', '--output-format', 'text',
]
/** A CLI that stops honouring the variable is slow again, never wrong. */
const GENERATE_ENV: Readonly<Record<string, string>> = { MAX_THINKING_TOKENS: '0' }

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
  /** Merge as a repository administrator, past branch protection (`gh pr merge --admin`). */
  readonly admin?: boolean
  /** Merge this pull request rather than the current branch's: a linked
   *  checkout may sit on another branch than the one it opened. */
  readonly pullNumber?: number
  /** Push once `resolve-continue` finishes the operation it resumed. */
  readonly push?: boolean
}

export interface PullRequestText {
  readonly title: string
  readonly body: string
}

interface BranchCommit {
  readonly subject: string
  readonly body: string
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

/** The model's answer as lines: fences and a trailing prose apology dropped,
 *  carriage returns and NULs (which git and the request validator refuse)
 *  gone, leading blank lines gone. */
function answerLines(value: string): readonly string[] {
  const lines = value.replace(/\0/gu, '').split(/\r?\n/u).map(line => line.trimEnd())
  const kept = lines.filter(line => !line.trim().startsWith('```'))
  while (kept.length > 0 && kept[0]?.trim() === '') kept.shift()
  while (kept.length > 0 && kept.at(-1)?.trim() === '') kept.pop()
  return kept
}

function unquoted(line: string): string {
  return line.trim().replace(/^['"`]+|['"`]+$/gu, '').trim()
}

/** Subject line, then a body when the model wrote one: the subject must at
 *  least look like one, the body is kept as the bullets the model listed, and the
 *  whole thing is cut at a line boundary under the commit-message cap. */
export function normalizeCommitMessage(value: string, fallback: string): string {
  const lines = answerLines(value)
  const subject = unquoted(lines[0] ?? '')
  if (subject.length === 0 || subject.length > MAX_SUBJECT_KEPT_CHARS) return fallback
  const body = lines.slice(1)
  while (body.length > 0 && body[0]?.trim() === '') body.shift()
  const kept: string[] = [subject]
  if (body.length > 0) kept.push('')
  let previousBlank = false
  let bullets = 0
  for (const line of body) {
    const blank = line.trim() === ''
    if (blank && previousBlank) continue
    previousBlank = blank
    if (/^\s*[-*]\s/u.test(line) && ++bullets > MAX_BODY_BULLETS) continue
    const next = [...kept, line].join('\n')
    if (next.length > MAX_MESSAGE_CHARS) break
    kept.push(line)
  }
  while (kept.length > 1 && kept.at(-1)?.trim() === '') kept.pop()
  return kept.join('\n')
}

/** `Title:` on its own line, then the `Summary:` / `Changes:` body the
 *  create-pr arm insists on. Anything else is the caller's fallback. */
export function parsePullRequestText(value: string): PullRequestText | undefined {
  const lines = answerLines(value)
  const titleAt = lines.findIndex(line => /^title:/iu.test(line.trim()))
  if (titleAt < 0) return undefined
  const title = unquoted(lines[titleAt]!.trim().replace(/^title:/iu, ''))
  if (title.length === 0 || title.length > MAX_PR_TITLE_CHARS) return undefined
  const summaryAt = lines.findIndex((line, index) => index > titleAt && /^summary:/iu.test(line.trim()))
  if (summaryAt < 0) return undefined
  const body = lines.slice(summaryAt).map(line => line.trim() === '' ? '' : line).join('\n').trim()
  return validPullRequestBody(body) && body.length <= MAX_PR_TEXT_CHARS ? { title, body } : undefined
}

function fallbackPullRequestText(commits: readonly BranchCommit[], files: readonly RepositoryActionFile[]): PullRequestText {
  const title = commits[0]?.subject ?? fallbackCommitMessage(files)
  const changes = commits.length > 0 ? commits.map(commit => commit.subject) : files.map(file => `Update ${file.path}`)
  return {
    title,
    body: `Summary: ${title}\n\nChanges:\n${(changes.length > 0 ? changes : [title]).map(item => `- ${item}`).join('\n')}`,
  }
}

function parseBranchCommits(output: string): readonly BranchCommit[] {
  return output.split('\0').flatMap(record => {
    const [subject = '', ...rest] = record.replace(/^\r?\n/u, '').split(/\r?\n/u)
    if (subject.trim().length === 0) return []
    return [{ subject: subject.trim().slice(0, 140), body: rest.join('\n').trim() }]
  }).slice(0, MAX_PR_COMMITS)
}

function boundedPatch(patch: string): { readonly text: string; readonly truncated: boolean } {
  return patch.length > MAX_GENERATE_PATCH_CHARS
    ? { text: patch.slice(0, MAX_GENERATE_PATCH_CHARS), truncated: true }
    : { text: patch, truncated: false }
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
    const git = await this.#git()
    // Style only: the subjects show how this repository phrases a change, the
    // diff is the only thing the message is allowed to describe.
    const recent = await this.#run(git, ['log', '--no-merges', '--format=%s', '-n', String(MAX_RECENT_SUBJECTS), 'HEAD', '--'], preview.root, GIT_TIMEOUT_MS)
    const subjects = recent.exitCode === 0 && !recent.lossy
      ? recent.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0)
      : []
    const patch = boundedPatch(preview.patch)
    const prompt = [
      'Write a git commit message for the changes below, in English, for someone skimming git log.',
      `Line 1 is the subject: imperative mood, at most ${MAX_SUBJECT_CHARS} characters, saying what the change does for the user or the code's behaviour, not which files it touches.`,
      'Most changes get the subject line only. Add a body only when the diff carries more than one change a reader would want to know about separately: leave line 2 blank, then one line per such change starting with "- ", a short sentence about what now behaves differently.',
      `Never more than ${MAX_BODY_BULLETS} bullets. Do not list tests, documentation, README, translations, type or wiring plumbing, or the propagation of one change through several layers: those are part of the change they serve, not changes of their own. Do not name files or identifiers unless nothing else identifies the change.`,
      'Describe only what the diff shows. Do not invent motivation, do not summarise the file list, and do not mention that the diff is truncated.',
      'Return only the message: no quotes, no markdown fences, no explanation before or after it.',
      ...(subjects.length > 0 ? [`Recent commit subjects of this repository, as a style reference only:\n${subjects.map(subject => `- ${subject}`).join('\n')}`] : []),
      `Files: ${preview.files.map(file => file.path).join(', ')}`,
      ...(patch.truncated || preview.truncated ? ['The diff below is cut short; the file list above is complete.'] : []),
      `Diff:\n${patch.text}`,
    ].join('\n')
    try {
      const result = await this.#run(this.#claudeExecutable, GENERATE_ARGUMENTS, preview.root, GENERATE_TIMEOUT_MS, MAX_OUTPUT_BYTES, GENERATE_ENV, prompt)
      return result.exitCode === 0 && !result.lossy ? normalizeCommitMessage(result.stdout, fallback) : fallback
    } catch {
      return fallback
    }
  }

  /** Title and description for the pull request the branch would open: the
   *  commits and diff since the base, plus whatever is still uncommitted,
   *  since create-pr commits that first. Base is the named branch on origin,
   *  else origin's default; with neither, the tree alone. */
  async generatePullRequest(cwd: string, fingerprint: string, baseBranch?: string): Promise<PullRequestText> {
    const preview = await this.#preview(cwd)
    if (preview.fingerprint !== fingerprint) throw new RepositoryActionError('repository-changed', 'Repository changes have changed. Refresh the commit panel.')
    const git = await this.#git()
    const base = await this.#baseRef(git, preview.root, baseBranch)
    let commits: readonly BranchCommit[] = []
    let branchPatch = ''
    let branchTruncated = false
    if (base !== undefined) {
      const log = await this.#run(git, ['log', '--no-merges', '--format=%s%n%b%x00', '-n', String(MAX_PR_COMMITS + 1), `${base}..HEAD`, '--'], preview.root, GIT_TIMEOUT_MS)
      if (log.exitCode === 0 && !log.lossy) commits = parseBranchCommits(log.stdout)
      const funcname = await diffFuncnameArgs()
      const diff = await this.#run(git, [...funcname, 'diff', '--no-ext-diff', '--no-color', '--unified=3', `${base}...HEAD`, '--', ':(exclude)WARP.md', ':(exclude)**/WARP.md'], preview.root, GIT_TIMEOUT_MS, MAX_OUTPUT_BYTES)
      if (diff.exitCode === 0) {
        branchPatch = diff.stdout
        branchTruncated = diff.lossy
      }
    }
    const fallback = fallbackPullRequestText(commits, preview.files)
    const patch = boundedPatch([branchPatch, preview.patch].filter(part => part.length > 0).join('\n'))
    const prompt = [
      'Write the title and description of a GitHub pull request for the changes below, in English.',
      'Answer in exactly this shape and nothing else:',
      `Title: <imperative title, at most ${MAX_SUBJECT_CHARS} characters, saying what the pull request does>`,
      'Summary: <one sentence saying what the pull request achieves as a whole>',
      '',
      'Changes:',
      '- <one line per independent change, describing what changed in the code>',
      '',
      `One bullet per change a reviewer would want to know about separately, at most ${MAX_BODY_BULLETS + 2}; a change with a single purpose gets one bullet. Tests, documentation, translations, and the plumbing that carries a change through several layers belong to the change they serve, not to bullets of their own. Do not describe anything the diff does not show.`,
      'No markdown headings, no quotes, no fences, no text before "Title:" or after the last bullet.',
      ...(commits.length > 0
        ? [`Commits on this branch, newest first:\n${commits.map(commit => (commit.body.length > 0 ? `- ${commit.subject}\n${commit.body}` : `- ${commit.subject}`)).join('\n')}`]
        : []),
      ...(preview.files.length > 0 ? [`Uncommitted files that will go into the same pull request: ${preview.files.map(file => file.path).join(', ')}`] : []),
      ...(patch.truncated || branchTruncated || preview.truncated ? ['The diff below is cut short; the commit list is complete.'] : []),
      `Diff:\n${patch.text}`,
    ].join('\n')
    try {
      const result = await this.#run(this.#claudeExecutable, GENERATE_ARGUMENTS, preview.root, GENERATE_TIMEOUT_MS, MAX_OUTPUT_BYTES, GENERATE_ENV, prompt)
      return (result.exitCode === 0 && !result.lossy ? parsePullRequestText(result.stdout) : undefined) ?? fallback
    } catch {
      return fallback
    }
  }

  /** `origin/<branch>` when the named branch exists on origin, else the branch
   *  origin's HEAD points at. Neither on a checkout that never fetched. */
  async #baseRef(git: string, root: string, baseBranch: string | undefined): Promise<string | undefined> {
    const named = baseBranch?.trim() ?? ''
    if (named.length > 0) {
      if (/[\0\r\n\s]|\.\.|^-/u.test(named)) return undefined
      const verified = await this.#run(git, ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', `refs/remotes/origin/${named}`], root, GIT_TIMEOUT_MS)
      return verified.exitCode === 0 && !verified.lossy && verified.stdout.trim() === `refs/remotes/origin/${named}` ? `origin/${named}` : undefined
    }
    const head = await this.#run(git, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root, GIT_TIMEOUT_MS)
    const ref = head.stdout.trim()
    return head.exitCode === 0 && !head.lossy && /^origin\/[^\s]+$/u.test(ref) ? ref : undefined
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
      const merged = await this.#run(gh, [
        'pr', 'merge',
        ...(request.pullNumber === undefined ? [] : [String(request.pullNumber)]),
        `--${method}`,
        ...(request.admin === true ? ['--admin'] : []),
      ], before.root, REMOTE_TIMEOUT_MS)
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

  #run(executable: string, args: readonly string[], cwd: string, timeoutMs: number, maxBytes = MAX_OUTPUT_BYTES, env: Readonly<Record<string, string>> = {}, stdin?: string): Promise<CommandResult> {
    return collect(this.#runtime.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: { stdin: stdin === undefined ? 'ignore' : { data: stdin }, stdout: { maxBytes }, stderr: { maxBytes: MAX_OUTPUT_BYTES } },
      graceMs: 1_000,
      signal: AbortSignal.timeout(timeoutMs),
      env,
    }))
  }
}
