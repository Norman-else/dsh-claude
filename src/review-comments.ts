import { randomUUID } from 'node:crypto'

const MAX_COMMENTS_PER_SESSION = 50
const MAX_TEXT_CHARS = 2_000
const MAX_PATH_CHARS = 1_024
const MAX_LINE = 10_000_000

export type ReviewCommentSide = 'old' | 'new'

export interface ReviewComment {
  readonly id: string
  readonly path: string
  /** Last (anchor) line of the comment. */
  readonly line: number
  /** First line when the comment spans a range; absent for single-line comments. */
  readonly startLine?: number
  readonly side: ReviewCommentSide
  readonly text: string
}

export class ReviewCommentError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ReviewCommentError'
    this.code = code
  }
}

function validSide(value: unknown): value is ReviewCommentSide {
  return value === 'old' || value === 'new'
}

/** Pending line comments queued per session until the next user turn drains them. */
export class ReviewCommentStore {
  readonly #comments = new Map<string, ReviewComment[]>()

  add(sessionId: string, input: { path: unknown; line: unknown; startLine?: unknown; side: unknown; text: unknown }): ReviewComment {
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (path.length === 0 || path.length > MAX_PATH_CHARS || /[\0\r\n]/u.test(path)) {
      throw new ReviewCommentError('invalid-request', 'The comment path is invalid.')
    }
    if (text.length === 0 || text.length > MAX_TEXT_CHARS || text.includes('\0')) {
      throw new ReviewCommentError('invalid-request', 'The comment text is invalid.')
    }
    if (typeof input.line !== 'number' || !Number.isSafeInteger(input.line) || input.line < 1 || input.line > MAX_LINE) {
      throw new ReviewCommentError('invalid-request', 'The comment line is invalid.')
    }
    if (!validSide(input.side)) throw new ReviewCommentError('invalid-request', 'The comment side is invalid.')
    const startLine = input.startLine === undefined || input.startLine === null ? undefined : input.startLine
    if (startLine !== undefined && (typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 1 || startLine > input.line)) {
      throw new ReviewCommentError('invalid-request', 'The comment start line is invalid.')
    }
    const existing = this.#comments.get(sessionId) ?? []
    if (existing.length >= MAX_COMMENTS_PER_SESSION) {
      throw new ReviewCommentError('too-many-comments', 'Too many pending review comments. Remove one before adding another.')
    }
    const comment: ReviewComment = { id: randomUUID(), path, line: input.line, ...(startLine === undefined || startLine === input.line ? {} : { startLine }), side: input.side, text }
    this.#comments.set(sessionId, [...existing, comment])
    return comment
  }

  remove(sessionId: string, id: string): boolean {
    const existing = this.#comments.get(sessionId)
    if (existing === undefined) return false
    const next = existing.filter(comment => comment.id !== id)
    if (next.length === existing.length) return false
    if (next.length === 0) this.#comments.delete(sessionId)
    else this.#comments.set(sessionId, next)
    return true
  }

  list(sessionId: string): readonly ReviewComment[] {
    return this.#comments.get(sessionId) ?? []
  }

  /** Remove and return every pending comment; called when a user turn consumes them. */
  drain(sessionId: string): readonly ReviewComment[] {
    const existing = this.#comments.get(sessionId) ?? []
    this.#comments.delete(sessionId)
    return existing
  }

  disposeSession(sessionId: string): void {
    this.#comments.delete(sessionId)
  }

  dispose(): void {
    this.#comments.clear()
  }
}

/** Render drained comments as the prompt block preceding the user's message text. */
export function formatReviewComments(comments: readonly ReviewComment[]): string {
  const lines = comments.map((comment, index) => (
    `${index + 1}. ${comment.path}:${comment.startLine === undefined ? comment.line : `${comment.startLine}-${comment.line}`}${comment.side === 'old' ? ' (old side)' : ''} — ${comment.text}`
  ))
  return [
    '<user-review-comments>',
    'The user attached these code review comments to this message. Each references a file and line (or line range) from the current working tree diff:',
    ...lines,
    '</user-review-comments>',
  ].join('\n')
}
