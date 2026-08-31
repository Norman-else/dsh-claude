import { CLAUDE_REVIEW_COMMENT_PATH } from '../constants.ts'
import type { ReviewComment, ReviewCommentSide } from '../review-comments.ts'
import { pluginWrite } from './plugin-transport.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function post(path: string, sessionId: string, body: Record<string, unknown>): Promise<unknown> {
  return await pluginWrite<unknown>(`${CLAUDE_REVIEW_COMMENT_PATH}${path}`, 'fast', undefined, {
    query: { sessionId },
    json: body,
  })
}

export async function addReviewComment(
  sessionId: string,
  comment: { path: string; line: number; startLine?: number; side: ReviewCommentSide; text: string },
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
