import { composeChecksPrompt, composeCommentsPrompt, type FailingCheck, type PullRequestReviewComment } from './pr-feedback-api.ts'

export const AUTO_FIX_INTERVAL_MS = 30_000
export const AUTO_FIX_FOOTER = 'This request was generated automatically by the pull request watcher. After making the changes, commit and push to the pull request branch so the checks re-run.'

/** What the watcher has already handed to Claude for one session. */
export interface AutoFixMemory {
  readonly handledCommentIds: ReadonlySet<number>
  readonly handledChecksSignature?: string
}

interface AutoFixSession {
  enabled: boolean
  memory: AutoFixMemory
}

const EMPTY_MEMORY: AutoFixMemory = { handledCommentIds: new Set() }
// ponytail: module-level map so the toggle survives session switches within
// one page; the watcher itself only ticks while the status bar is mounted.
const sessions = new Map<string, AutoFixSession>()

function session(sessionId: string): AutoFixSession {
  let entry = sessions.get(sessionId)
  if (entry === undefined) {
    entry = { enabled: false, memory: EMPTY_MEMORY }
    sessions.set(sessionId, entry)
  }
  return entry
}

export function autoFixEnabled(sessionId: string): boolean {
  return session(sessionId).enabled
}

export function setAutoFixEnabled(sessionId: string, enabled: boolean): void {
  session(sessionId).enabled = enabled
}

export function autoFixMemory(sessionId: string): AutoFixMemory {
  return session(sessionId).memory
}

export function rememberAutoFix(sessionId: string, memory: AutoFixMemory): void {
  session(sessionId).memory = memory
}

/** One failing CI run yields one fix attempt: run links change when CI re-runs. */
export function checksSignature(checks: readonly FailingCheck[]): string | undefined {
  if (checks.length === 0) return undefined
  return checks.map(check => `${check.name}|${check.link ?? ''}`).sort().join('\n')
}

export function planAutoFix(
  memory: AutoFixMemory,
  comments: readonly PullRequestReviewComment[],
  checks: readonly FailingCheck[],
): { prompt?: string; memory: AutoFixMemory } {
  const fresh = comments.filter(comment => !memory.handledCommentIds.has(comment.id))
  const signature = checksSignature(checks)
  const checksChanged = signature !== undefined && signature !== memory.handledChecksSignature
  const sections: string[] = []
  if (fresh.length > 0) sections.push(composeCommentsPrompt(fresh))
  if (checksChanged) sections.push(composeChecksPrompt(checks))
  if (sections.length === 0) return { memory }
  const nextSignature = checksChanged ? signature : memory.handledChecksSignature
  return {
    prompt: `${sections.join('\n\n')}\n\n${AUTO_FIX_FOOTER}`,
    memory: {
      handledCommentIds: new Set([...memory.handledCommentIds, ...fresh.map(comment => comment.id)]),
      ...(nextSignature === undefined ? {} : { handledChecksSignature: nextSignature }),
    },
  }
}
