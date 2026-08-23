import { CLAUDE_REVIEW_COMMENT_PATH } from '../constants.ts'
import type { ReviewComment, ReviewCommentSide } from '../review-comments.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function post(path: string, sessionId: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${CLAUDE_REVIEW_COMMENT_PATH}${path}?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await response.json() as unknown
  if (!response.ok) {
    const error = record(value)
    throw new Error(typeof error?.message === 'string' ? error.message : 'Review comment request failed.')
  }
  return value
}

export async function addReviewComment(
  sessionId: string,
  comment: { path: string; line: number; side: ReviewCommentSide; text: string },
): Promise<ReviewComment> {
  const value = record(await post('', sessionId, comment))
  const created = record(value?.comment)
  if (created === undefined || typeof created.id !== 'string') throw new Error('Invalid review comment response.')
  return created as unknown as ReviewComment
}

export async function removeReviewComment(sessionId: string, id: string): Promise<void> {
  await post('/remove', sessionId, { id })
}

export async function clearReviewComments(sessionId: string): Promise<void> {
  await post('/clear', sessionId, {})
}
