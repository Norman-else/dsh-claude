import { CLAUDE_REPOSITORY_FEEDBACK_PATH } from '../constants.ts'
import type { FailingCheck, PullRequestReviewComment } from '../pr-feedback.ts'
import { PLUGIN_READ_TIMEOUT_MS, pluginRequestSignal } from './plugin-request.ts'

export type { FailingCheck, PullRequestReviewComment } from '../pr-feedback.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function loadJson(path: string, sessionId: string, pullNumber: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}${path}?sessionId=${encodeURIComponent(sessionId)}&number=${pullNumber}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    signal: pluginRequestSignal(PLUGIN_READ_TIMEOUT_MS, signal),
  })
  const body = record(await response.json() as unknown)
  if (!response.ok) {
    throw new Error(typeof body?.message === 'string' ? body.message : 'Pull request feedback is unavailable.')
  }
  if (body === undefined) throw new Error('Invalid pull request feedback response.')
  return body
}

export async function loadPullRequestComments(sessionId: string, pullNumber: number, signal?: AbortSignal): Promise<readonly PullRequestReviewComment[]> {
  const body = await loadJson('/comments', sessionId, pullNumber, signal)
  if (!Array.isArray(body.comments)) throw new Error('Invalid pull request comments response.')
  const comments: PullRequestReviewComment[] = []
  for (const item of body.comments) {
    const input = record(item)
    if (input === undefined || typeof input.id !== 'number' || typeof input.path !== 'string'
      || typeof input.author !== 'string' || typeof input.body !== 'string' || typeof input.url !== 'string'
      || (input.side !== 'new' && input.side !== 'old')
      || (input.line !== undefined && typeof input.line !== 'number')) continue
    comments.push(input as unknown as PullRequestReviewComment)
  }
  return comments
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

/** Draft handed to Claude when the user forwards GitHub review comments. */
export function composeCommentsPrompt(comments: readonly PullRequestReviewComment[]): string {
  const lines = comments.map(comment => `- ${comment.path}${comment.line === undefined ? '' : `:${comment.line}`} (@${comment.author}): ${comment.body.replaceAll('\n', '\n  ')}`)
  return `Please address the following GitHub pull request review comments. Make the requested changes, or explain briefly when a comment should not be applied.\n\n${lines.join('\n')}`
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

/** Draft handed to Claude after an update-branch merge left conflicts behind. */
export function composeConflictsPrompt(baseBranch: string, conflicts: readonly string[], method: 'merge' | 'rebase' = 'merge'): string {
  const list = conflicts.map(file => `- ${file}`).join('\n')
  if (method === 'rebase') {
    return `Rebasing the current branch onto origin/${baseBranch} stopped on conflicts in the files below. Resolve each conflict preserving the intent of both sides, stage the files, run \`git rebase --continue\` until the rebase finishes, then push with \`git push --force-with-lease\`.\n\n${list}`
  }
  return `Merging origin/${baseBranch} into the current branch left merge conflicts in the files below. Resolve each conflict preserving the intent of both sides, then commit the merge.\n\n${list}`
}
