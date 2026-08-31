import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { githubAvatarUrl } from './github-url.ts'
import { parseGitHubRemote } from './repository-status.ts'

export { githubAvatarUrl } from './github-url.ts'

const MAX_OUTPUT_BYTES = 512 * 1024
const GIT_TIMEOUT_MS = 10_000
const GH_TIMEOUT_MS = 60_000
const MAX_COMMENTS = 100
const MAX_THREADS = 100
const MAX_MENTIONABLE_USERS = 20
const MAX_REPLY_CHARS = 2_000
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
  /** ISO timestamp GitHub reports; the panel shows it the way GitHub does. */
  readonly createdAt?: string
  /** App account. GraphQL reports it as an actor type; REST spells the login
   *  `name[bot]`. Either way the panel shows a Bot pill, like GitHub. */
  readonly bot?: boolean
}

/** One GitHub review conversation: the comments share an anchor, and Resolve
 *  acts on the thread rather than on any single comment. */
export interface PullRequestReviewThread {
  /** GraphQL node id — the only handle the resolve mutations accept. */
  readonly id: string
  readonly path: string
  readonly line?: number
  readonly side: 'new' | 'old'
  readonly resolved: boolean
  readonly outdated: boolean
  readonly comments: readonly PullRequestReviewComment[]
}

/** A user GitHub will notify when the reply names them. */
export interface MentionableUser {
  readonly login: string
  readonly avatarUrl?: string
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

/** Threads carry the anchor; comments carry the prose. `isOutdated` marks a
 *  thread whose lines the branch has since moved past. */
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          id isResolved isOutdated path line originalLine diffSide
          comments(first:50){ nodes{ databaseId body url createdAt author{ __typename login avatarUrl } } }
        }
      }
    }
  }
}`

const RESOLVE_MUTATION = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
}`

const UNRESOLVE_MUTATION = `mutation($threadId:ID!){
  unresolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
}`

const MENTIONABLE_USERS_QUERY = `query($owner:String!,$name:String!,$q:String!){
  repository(owner:$owner,name:$name){
    mentionableUsers(first:20,query:$q){ nodes{ login avatarUrl } }
  }
}`

async function collect(handle: SubprocessHandle): Promise<CommandResult> {
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  return { exitCode: outcome.exitCode, stdout: stdout?.text ?? '', lossy: stdout?.lossy === true }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Read `repository.pullRequest.reviewThreads.nodes` out of a GraphQL response.
 *  A payload carrying `errors` instead of data yields nothing rather than
 *  throwing: the caller distinguishes "no threads" from "call failed" by the
 *  process exit code. */
export function parseReviewThreads(value: unknown): readonly PullRequestReviewThread[] {
  const nodes = record(record(record(record(record(value)?.data)?.repository)?.pullRequest)?.reviewThreads)?.nodes
  if (!Array.isArray(nodes)) return []
  const threads: PullRequestReviewThread[] = []
  let total = 0
  for (const item of nodes) {
    const input = record(item)
    if (input === undefined || typeof input.id !== 'string' || input.id.length === 0) continue
    const path = typeof input.path === 'string' ? input.path : ''
    if (path.length === 0) continue
    const line = Number.isSafeInteger(input.line)
      ? Number(input.line)
      : Number.isSafeInteger(input.originalLine) ? Number(input.originalLine) : undefined
    const side = input.diffSide === 'LEFT' ? 'old' as const : 'new' as const
    const anchor = { path, ...(line === undefined ? {} : { line }), side }
    const comments: PullRequestReviewComment[] = []
    const commentNodes = record(input.comments)?.nodes
    for (const node of Array.isArray(commentNodes) ? commentNodes : []) {
      if (total >= MAX_COMMENTS) break
      const comment = record(node)
      if (comment === undefined || !Number.isSafeInteger(comment.databaseId)) continue
      const body = typeof comment.body === 'string' ? comment.body.trim() : ''
      if (body.length === 0) continue
      const author = record(comment.author)
      const avatarUrl = githubAvatarUrl(author?.avatarUrl)
      const login = typeof author?.login === 'string' ? author.login : 'unknown'
      comments.push({
        id: Number(comment.databaseId),
        ...anchor,
        author: login,
        ...(author?.__typename === 'Bot' || login.endsWith('[bot]') ? { bot: true } : {}),
        ...(avatarUrl === undefined ? {} : { avatarUrl }),
        body: body.slice(0, MAX_COMMENT_CHARS),
        url: typeof comment.url === 'string' ? comment.url : '',
        ...(typeof comment.createdAt === 'string' ? { createdAt: comment.createdAt } : {}),
      })
      total += 1
    }
    // A thread with nothing readable left is not worth an anchor in the diff.
    if (comments.length === 0) continue
    threads.push({
      id: input.id,
      ...anchor,
      resolved: input.isResolved === true,
      outdated: input.isOutdated === true,
      comments,
    })
    if (threads.length >= MAX_THREADS || total >= MAX_COMMENTS) break
  }
  return threads
}

/** One posted reply, shaped like the thread comments it joins. */
export function parseReplyComment(value: unknown, anchor: { path: string; line?: number; side: 'new' | 'old' }): PullRequestReviewComment | undefined {
  const input = record(value)
  if (input === undefined || !Number.isSafeInteger(input.id)) return undefined
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (body.length === 0) return undefined
  const user = record(input.user)
  const avatarUrl = githubAvatarUrl(user?.avatar_url)
  const login = typeof user?.login === 'string' ? user.login : 'unknown'
  return {
    id: Number(input.id),
    ...anchor,
    author: login,
    ...(user?.type === 'Bot' || login.endsWith('[bot]') ? { bot: true } : {}),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    body: body.slice(0, MAX_COMMENT_CHARS),
    url: typeof input.html_url === 'string' ? input.html_url : '',
    ...(typeof input.created_at === 'string' ? { createdAt: input.created_at } : {}),
  }
}

export function parseMentionableUsers(value: unknown): readonly MentionableUser[] {
  const nodes = record(record(record(record(value)?.data)?.repository)?.mentionableUsers)?.nodes
  if (!Array.isArray(nodes)) return []
  const users: MentionableUser[] = []
  for (const item of nodes) {
    const input = record(item)
    if (input === undefined || typeof input.login !== 'string' || input.login.length === 0) continue
    const avatarUrl = githubAvatarUrl(input.avatarUrl)
    users.push({ login: input.login, ...(avatarUrl === undefined ? {} : { avatarUrl }) })
    if (users.length >= MAX_MENTIONABLE_USERS) break
  }
  return users
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

  async threads(cwd: string, pullNumber: number): Promise<readonly PullRequestReviewThread[]> {
    const { owner, name } = await this.#repositoryParts(cwd)
    const gh = await this.#gh()
    const result = await this.#run(gh, [
      'api', 'graphql',
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pullNumber}`,
      '-f', `query=${REVIEW_THREADS_QUERY}`,
    ], cwd, GH_TIMEOUT_MS)
    if (result.exitCode !== 0) throw new PullRequestFeedbackError('comments-unavailable', 'Pull request comments could not be loaded.')
    try {
      return parseReviewThreads(JSON.parse(result.stdout))
    } catch {
      throw new PullRequestFeedbackError('comments-unavailable', 'Pull request comments could not be parsed.')
    }
  }

  /** Post a reply into the thread the given comment belongs to. GitHub parses
   *  `@login` in the body server-side, so mentions need nothing from us. */
  async reply(cwd: string, pullNumber: number, commentId: number, body: string): Promise<PullRequestReviewComment> {
    const text = body.trim()
    if (text.length === 0 || text.length > MAX_REPLY_CHARS) {
      throw new PullRequestFeedbackError('invalid-request', 'The reply body is invalid.')
    }
    const repository = await this.#repository(cwd)
    const gh = await this.#gh()
    const result = await this.#run(
      gh,
      ['api', '-X', 'POST', `repos/${repository}/pulls/${pullNumber}/comments/${commentId}/replies`, '--input', '-'],
      cwd,
      GH_TIMEOUT_MS,
      JSON.stringify({ body: text }),
    )
    if (result.exitCode !== 0) throw new PullRequestFeedbackError('reply-failed', 'The reply could not be posted.')
    let posted: PullRequestReviewComment | undefined
    try {
      const parsed = JSON.parse(result.stdout) as unknown
      const path = typeof record(parsed)?.path === 'string' ? String(record(parsed)?.path) : ''
      const line = Number.isSafeInteger(record(parsed)?.line) ? Number(record(parsed)?.line) : undefined
      posted = parseReplyComment(parsed, {
        path,
        ...(line === undefined ? {} : { line }),
        side: record(parsed)?.side === 'LEFT' ? 'old' : 'new',
      })
    } catch {
      posted = undefined
    }
    if (posted === undefined) throw new PullRequestFeedbackError('reply-failed', 'The posted reply could not be read back.')
    return posted
  }

  /** Resolve or reopen a thread. Returns the state GitHub reports afterwards. */
  async setResolved(cwd: string, threadId: string, resolved: boolean): Promise<boolean> {
    const gh = await this.#gh()
    const result = await this.#run(gh, [
      'api', 'graphql',
      '-f', `threadId=${threadId}`,
      '-f', `query=${resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION}`,
    ], cwd, GH_TIMEOUT_MS)
    if (result.exitCode !== 0) throw new PullRequestFeedbackError('resolve-failed', 'The thread could not be updated.')
    try {
      const data = record(record(JSON.parse(result.stdout) as unknown)?.data)
      const thread = record(record(data?.[resolved ? 'resolveReviewThread' : 'unresolveReviewThread'])?.thread)
      if (typeof thread?.isResolved !== 'boolean') throw new Error('missing state')
      return thread.isResolved
    } catch {
      throw new PullRequestFeedbackError('resolve-failed', 'The thread state could not be read back.')
    }
  }

  /** Logins GitHub would notify from this repository, for the reply composer. */
  async mentionables(cwd: string, query: string): Promise<readonly MentionableUser[]> {
    const { owner, name } = await this.#repositoryParts(cwd)
    const gh = await this.#gh()
    const result = await this.#run(gh, [
      'api', 'graphql',
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `q=${query}`,
      '-f', `query=${MENTIONABLE_USERS_QUERY}`,
    ], cwd, GH_TIMEOUT_MS)
    if (result.exitCode !== 0) return []
    try {
      return parseMentionableUsers(JSON.parse(result.stdout))
    } catch {
      return []
    }
  }

  /** `signal` bounds the log fetches below: each is capped on its own, but they
   *  run one after another, so the honest worst case is their sum rather than
   *  any single ceiling — more than a route is allowed to hold a connection. */
  async failingChecks(cwd: string, pullNumber: number, signal?: AbortSignal): Promise<readonly FailingCheck[]> {
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
      if (signal?.aborted === true) {
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

  /** GraphQL takes the owner and the name as separate variables, so they never
   *  reach the query text itself. */
  async #repositoryParts(cwd: string): Promise<{ owner: string; name: string }> {
    const [owner, name] = (await this.#repository(cwd)).split('/')
    if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
      throw new PullRequestFeedbackError('no-github-remote', 'The repository has no GitHub origin remote.')
    }
    return { owner, name }
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

  #run(executable: string, args: readonly string[], cwd: string, timeoutMs: number, input?: string): Promise<CommandResult> {
    const handle = this.#runtime.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: input === undefined ? 'ignore' : 'pipe',
        stdout: { maxBytes: MAX_OUTPUT_BYTES },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 1_000,
      signal: AbortSignal.timeout(timeoutMs),
      env: {},
    })
    if (input !== undefined) handle.stdin?.end(input)
    return collect(handle)
  }
}
