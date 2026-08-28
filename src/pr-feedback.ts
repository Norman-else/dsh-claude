import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { parseGitHubRemote } from './repository-status.ts'

const MAX_OUTPUT_BYTES = 512 * 1024
const GIT_TIMEOUT_MS = 10_000
const GH_TIMEOUT_MS = 60_000
const MAX_COMMENTS = 100
const MAX_COMMENT_CHARS = 4_096
const MAX_FAILING_CHECKS = 3
const MAX_LOG_CHARS = 8 * 1024

type FeedbackRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly lossy: boolean
}

export interface PullRequestReviewComment {
  readonly id: number
  readonly path: string
  readonly line?: number
  readonly side: 'new' | 'old'
  readonly author: string
  /** GitHub-hosted avatar of the comment's author, when the API named one. */
  readonly avatarUrl?: string
  readonly body: string
  readonly url: string
}

export interface FailingCheck {
  readonly name: string
  readonly link?: string
  readonly description?: string
  readonly log?: string
}

export class PullRequestFeedbackError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PullRequestFeedbackError'
    this.code = code
  }
}

async function collect(handle: SubprocessHandle): Promise<CommandResult> {
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  return { exitCode: outcome.exitCode, stdout: stdout?.text ?? '', lossy: stdout?.lossy === true }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Only GitHub's own image hosts; the browser loads these directly, so a URL
 *  the API did not vouch for must never become an outbound request. */
export function githubAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) return undefined
  try {
    const url = new URL(value)
    const allowed = url.hostname === 'github.com' || url.hostname === 'githubusercontent.com' || url.hostname.endsWith('.githubusercontent.com')
    return url.protocol === 'https:' && allowed ? url.href : undefined
  } catch {
    return undefined
  }
}

export function parseReviewComments(value: unknown): readonly PullRequestReviewComment[] {
  if (!Array.isArray(value)) return []
  const comments: PullRequestReviewComment[] = []
  for (const item of value) {
    const input = record(item)
    if (input === undefined || !Number.isSafeInteger(input.id)) continue
    const body = typeof input.body === 'string' ? input.body.trim() : ''
    const path = typeof input.path === 'string' ? input.path : ''
    const url = typeof input.html_url === 'string' ? input.html_url : ''
    if (body.length === 0 || path.length === 0) continue
    const avatarUrl = githubAvatarUrl(record(input.user)?.avatar_url)
    const line = Number.isSafeInteger(input.line)
      ? Number(input.line)
      : Number.isSafeInteger(input.original_line) ? Number(input.original_line) : undefined
    comments.push({
      id: Number(input.id),
      path,
      ...(line === undefined ? {} : { line }),
      side: input.side === 'LEFT' ? 'old' : 'new',
      author: typeof record(input.user)?.login === 'string' ? String(record(input.user)?.login) : 'unknown',
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      body: body.slice(0, MAX_COMMENT_CHARS),
      url,
    })
    if (comments.length >= MAX_COMMENTS) break
  }
  return comments
}

/** Extract the Actions job id from a check run link, when it is one. */
export function actionsJobId(link: string | undefined): string | undefined {
  if (link === undefined) return undefined
  return /\/actions\/runs\/\d+\/jobs?\/(\d+)/u.exec(link)?.[1]
}

export function parseFailingChecks(value: unknown): readonly FailingCheck[] {
  if (!Array.isArray(value)) return []
  const failing: FailingCheck[] = []
  for (const item of value) {
    const input = record(item)
    if (input === undefined || input.bucket !== 'fail' || typeof input.name !== 'string') continue
    failing.push({
      name: input.name,
      ...(typeof input.link === 'string' && input.link.length > 0 ? { link: input.link } : {}),
      ...(typeof input.description === 'string' && input.description.length > 0 ? { description: input.description } : {}),
    })
  }
  return failing
}

/** Keep the informative end of a failed-job log within the size budget. */
export function boundedLogTail(value: string): string {
  const text = value.replaceAll('\0', '').trimEnd()
  return text.length <= MAX_LOG_CHARS ? text : text.slice(text.length - MAX_LOG_CHARS)
}

export class PullRequestFeedbackService {
  readonly #runtime: FeedbackRuntime
  #gitExecutable?: Promise<string>
  #ghExecutable?: Promise<string>

  constructor(runtime: FeedbackRuntime) {
    this.#runtime = runtime
  }

  async comments(cwd: string, pullNumber: number): Promise<readonly PullRequestReviewComment[]> {
    const repository = await this.#repository(cwd)
    const gh = await this.#gh()
    const result = await this.#run(gh, [
      'api', `repos/${repository}/pulls/${pullNumber}/comments`, '--paginate',
    ], cwd, GH_TIMEOUT_MS)
    if (result.exitCode !== 0) throw new PullRequestFeedbackError('comments-unavailable', 'Pull request comments could not be loaded.')
    try {
      // --paginate concatenates one JSON array per page.
      const pages = result.stdout.replaceAll('][', ',')
      return parseReviewComments(JSON.parse(pages))
    } catch {
      throw new PullRequestFeedbackError('comments-unavailable', 'Pull request comments could not be parsed.')
    }
  }

  async failingChecks(cwd: string, pullNumber: number): Promise<readonly FailingCheck[]> {
    const gh = await this.#gh()
    const result = await this.#run(gh, [
      'pr', 'checks', String(pullNumber), '--json', 'name,state,link,description,bucket',
    ], cwd, GH_TIMEOUT_MS)
    // gh pr checks exits non-zero when checks are failing; that IS our case.
    let checks: readonly FailingCheck[]
    try {
      checks = parseFailingChecks(JSON.parse(result.stdout))
    } catch {
      throw new PullRequestFeedbackError('checks-unavailable', 'Pull request checks could not be loaded.')
    }
    const detailed: FailingCheck[] = []
    for (const check of checks) {
      const jobId = detailed.length < MAX_FAILING_CHECKS ? actionsJobId(check.link) : undefined
      if (jobId === undefined) {
        detailed.push(check)
        continue
      }
      const log = await this.#run(gh, ['run', 'view', '--job', jobId, '--log-failed'], cwd, GH_TIMEOUT_MS)
      detailed.push(log.exitCode === 0 && log.stdout.trim().length > 0 ? { ...check, log: boundedLogTail(log.stdout) } : check)
    }
    return detailed
  }

  async #repository(cwd: string): Promise<string> {
    const git = await this.#git()
    const remote = await this.#run(git, ['remote', 'get-url', 'origin'], cwd, GIT_TIMEOUT_MS)
    const repository = remote.exitCode === 0 ? parseGitHubRemote(remote.stdout) : undefined
    if (repository === undefined) throw new PullRequestFeedbackError('no-github-remote', 'The repository has no GitHub origin remote.')
    return repository
  }

  #git(): Promise<string> {
    this.#gitExecutable ??= this.#runtime.resolveExecutable('git')
    return this.#gitExecutable
  }

  #gh(): Promise<string> {
    this.#ghExecutable ??= this.#runtime.resolveExecutable('gh').catch(() => {
      throw new PullRequestFeedbackError('gh-unavailable', 'GitHub CLI is unavailable.')
    })
    return this.#ghExecutable
  }

  #run(executable: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
    return collect(this.#runtime.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT_BYTES }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 1_000,
      signal: AbortSignal.timeout(timeoutMs),
      env: {},
    }))
  }
}
