import { CLAUDE_REPOSITORY_FEEDBACK_PATH } from '../constants.ts'
import type { RepositoryOperation } from '../repository-status.ts'
import { githubAvatarUrl } from '../github-url.ts'
import type { FailingCheck, MentionableUser, PullRequestReviewComment, PullRequestReviewThread } from '../pr-feedback.ts'
import { pluginRead, pluginWrite } from './plugin-transport.ts'

export type { FailingCheck, MentionableUser, PullRequestReviewComment, PullRequestReviewThread } from '../pr-feedback.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function feedbackQuery(sessionId: string, pullNumber: number, extra?: Readonly<Record<string, string>>): Record<string, string> {
  return { sessionId, number: String(pullNumber), ...extra }
}

function answer(value: unknown): Record<string, unknown> {
  const body = record(value)
  if (body === undefined) throw new Error('Invalid pull request feedback response.')
  return body
}

/** Every arm of this route shells out to `gh`, so reads and writes alike take
 *  the remote budget. */
async function loadJson(
  path: string,
  sessionId: string,
  pullNumber: number,
  signal?: AbortSignal,
  extra?: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  return answer(await pluginRead<unknown>(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}${path}`, 'remote', signal, {
    query: feedbackQuery(sessionId, pullNumber, extra),
  }))
}

async function postJson(path: string, sessionId: string, pullNumber: number, input: unknown): Promise<Record<string, unknown>> {
  return answer(await pluginWrite<unknown>(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}${path}`, 'remote', undefined, {
    query: feedbackQuery(sessionId, pullNumber),
    json: input,
  }))
}

function reviewComment(value: unknown): PullRequestReviewComment | undefined {
  const input = record(value)
  if (input === undefined || typeof input.id !== 'number' || typeof input.path !== 'string'
    || typeof input.author !== 'string' || typeof input.body !== 'string' || typeof input.url !== 'string'
    || (input.avatarUrl !== undefined && githubAvatarUrl(input.avatarUrl) === undefined)
    || (input.side !== 'new' && input.side !== 'old')
    || (input.line !== undefined && typeof input.line !== 'number')
    || (input.createdAt !== undefined && typeof input.createdAt !== 'string')
    || (input.bot !== undefined && typeof input.bot !== 'boolean')) return undefined
  return input as unknown as PullRequestReviewComment
}

export async function loadPullRequestThreads(sessionId: string, pullNumber: number, signal?: AbortSignal): Promise<readonly PullRequestReviewThread[]> {
  const body = await loadJson('/comments', sessionId, pullNumber, signal)
  if (!Array.isArray(body.threads)) throw new Error('Invalid pull request comments response.')
  const threads: PullRequestReviewThread[] = []
  for (const item of body.threads) {
    const input = record(item)
    if (input === undefined || typeof input.id !== 'string' || typeof input.path !== 'string'
      || (input.side !== 'new' && input.side !== 'old')
      || (input.line !== undefined && typeof input.line !== 'number')
      || !Array.isArray(input.comments)) continue
    const comments = input.comments.map(reviewComment).filter((value): value is PullRequestReviewComment => value !== undefined)
    if (comments.length === 0) continue
    threads.push({
      id: input.id,
      path: input.path,
      ...(typeof input.line === 'number' ? { line: input.line } : {}),
      side: input.side,
      resolved: input.resolved === true,
      outdated: input.outdated === true,
      comments,
    })
  }
  return threads
}

/** Post one reply into the thread that `commentId` belongs to. */
export async function replyToReviewThread(
  sessionId: string,
  pullNumber: number,
  commentId: number,
  body: string,
): Promise<PullRequestReviewComment> {
  const answer = await postJson('/reply', sessionId, pullNumber, { commentId, body })
  const comment = reviewComment(answer.comment)
  if (comment === undefined) throw new Error('Invalid pull request reply response.')
  return comment
}

/** Resolve or reopen a thread; returns the state GitHub reports afterwards. */
export async function setReviewThreadResolved(
  sessionId: string,
  pullNumber: number,
  threadId: string,
  resolved: boolean,
): Promise<boolean> {
  const answer = await postJson('/resolve', sessionId, pullNumber, { threadId, resolved })
  if (typeof answer.resolved !== 'boolean') throw new Error('Invalid pull request resolve response.')
  return answer.resolved
}

/** Logins GitHub would notify, for the reply composer's `@` completion. */
export async function loadMentionableUsers(
  sessionId: string,
  pullNumber: number,
  query: string,
  signal?: AbortSignal,
): Promise<readonly MentionableUser[]> {
  const body = await loadJson('/mentionables', sessionId, pullNumber, signal, { q: query })
  if (!Array.isArray(body.users)) return []
  const users: MentionableUser[] = []
  for (const item of body.users) {
    const input = record(item)
    if (input === undefined || typeof input.login !== 'string' || input.login.length === 0) continue
    const avatarUrl = githubAvatarUrl(input.avatarUrl)
    users.push({ login: input.login, ...(avatarUrl === undefined ? {} : { avatarUrl }) })
  }
  return users
}

export async function loadFailingChecks(sessionId: string, pullNumber: number, signal?: AbortSignal): Promise<readonly FailingCheck[]> {
  const body = await loadJson('/checks', sessionId, pullNumber, signal)
  if (!Array.isArray(body.checks)) throw new Error('Invalid pull request checks response.')
  const checks: FailingCheck[] = []
  for (const item of body.checks) {
    const input = record(item)
    if (input === undefined || typeof input.name !== 'string'
      || (input.link !== undefined && typeof input.link !== 'string')
      || (input.description !== undefined && typeof input.description !== 'string')
      || (input.log !== undefined && typeof input.log !== 'string')) continue
    checks.push(input as unknown as FailingCheck)
  }
  return checks
}

/** Review bots sign a comment with an attribution line and an actions checklist
 *  aimed at the bot itself; in a prompt both are noise, and "apply fix" reads as
 *  an instruction Claude cannot follow. */
function commentText(body: string): string {
  const lines = body.replaceAll(/<!--[\s\S]*?-->/g, '').split('\n')
    .filter(line => !/^\s*<sup>[\s\S]*<\/sup>\s*$/.test(line))
  let end = lines.length
  while (end > 0 && /^\s*(?:-{3,}|\*\*[^*]+\*\*|[-*] \[[ xX]\].*)?\s*$/.test(lines[end - 1] ?? '')) end -= 1
  // Only a block that actually holds a checkbox is a bot footer; a comment
  // ending in a bold sentence or a rule keeps it.
  const trailer = lines.slice(end)
  return (trailer.some(line => /^\s*[-*] \[[ xX]\]/.test(line)) ? lines.slice(0, end) : lines).join('\n').trim()
}

/** A one-line comment sits after the author; anything longer starts on its own
 *  line, so its headings and lists keep meaning instead of running into ours. */
function attributed(prefix: string, body: string): string {
  const text = commentText(body)
  const indented = text.split('\n').map(line => (line.length === 0 ? line : `  ${line}`)).join('\n')
  return text.includes('\n') ? `${prefix}\n\n${indented}` : `${prefix} ${text}`
}

/** Draft handed to Claude when the user forwards GitHub review comments. A
 *  resolved thread is a settled conversation: forwarding it would ask Claude to
 *  redo work the reviewers already signed off. */
export function composeCommentsPrompt(threads: readonly PullRequestReviewThread[]): string {
  const open = threads.filter(thread => !thread.resolved)
  if (open.length === 0) return ''
  const blocks = open.map((thread) => {
    const [first, ...rest] = thread.comments
    if (first === undefined) return ''
    const anchor = `${thread.path}${thread.line === undefined ? '' : `:${thread.line}`}`
    const head = attributed(`- ${anchor} (@${first.author}):`, first.body)
    // Later comments are the rest of that conversation, indented under it.
    const replies = rest.map(reply => attributed(`  (@${reply.author}):`, reply.body))
    return [head, ...replies].join('\n')
  }).filter(block => block.length > 0)
  return `Please address the following GitHub pull request review comments. Make the requested changes, or explain briefly when a comment should not be applied.\n\n${blocks.join('\n\n')}`
}

/** Draft handed to Claude when the user forwards failing CI checks. */
export function composeChecksPrompt(checks: readonly FailingCheck[]): string {
  const sections = checks.map(check => {
    const heading = `## ${check.name}${check.link === undefined ? '' : ` (${check.link})`}`
    const description = check.description === undefined ? '' : `\n${check.description}`
    const log = check.log === undefined ? '' : `\n\n\`\`\`\n${check.log}\n\`\`\``
    return `${heading}${description}${log}`
  })
  return `The following CI checks are failing on the current pull request. Investigate the failure logs, fix the underlying problems, and re-run the relevant commands locally when possible.\n\n${sections.join('\n\n')}`
}

/** Draft handed to Claude for a stopped merge, rebase, cherry-pick or revert --
 *  from the update-branch dialog that caused one, or from the repository bar
 *  for one already in the tree, where the base branch is not always known. */
export function composeConflictsPrompt(
  conflicts: readonly string[],
  operation: RepositoryOperation = 'merge',
  baseBranch?: string,
): string {
  const list = conflicts.map(file => `- ${file}`).join('\n')
  const base = baseBranch === undefined ? undefined : `origin/${baseBranch}`
  const head = operation === 'rebase'
    ? `Rebasing the current branch${base === undefined ? '' : ` onto ${base}`} stopped on conflicts in the files below.`
    : operation === 'merge'
      ? `Merging ${base ?? 'the base branch'} into the current branch left conflicts in the files below.`
      : `A ${operation} stopped on conflicts in the files below.`
  const push = operation === 'rebase' && baseBranch !== undefined
    ? ' Once it finishes, push with `git push --force-with-lease`.'
    : ''
  return `${head} Resolve each conflict preserving the intent of both sides, stage the resolved files, then run \`git ${operation} --continue\` until the ${operation} finishes.${push}\n\n${list}`
}
