import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REVIEW_COMMENT_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import { ReviewCommentError, type ReviewCommentStore } from './review-comments.ts'

const MAX_BODY_BYTES = 16 * 1024
const MAX_SESSION_ID_CHARS = 1_024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(io: PluginRouteIo): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await io.body<unknown>(MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    throw new ReviewCommentError('body-too-large', 'The request body is too large.')
  }
  const value = record(parsed)
  if (value === undefined) throw new ReviewCommentError('invalid-request', 'The request body is invalid.')
  return value
}

function sessionIdFromUrl(url: URL): string {
  const value = url.searchParams.get('sessionId')
  if (value === null || value.length === 0 || value.length > MAX_SESSION_ID_CHARS) {
    throw new ReviewCommentError('invalid-session', 'The session is invalid.')
  }
  return value
}

export function registerReviewCommentRoute(
  ctx: Context,
  store: ReviewCommentStore,
  ownsSession: (sessionId: string) => boolean,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'prefix',
    path: CLAUDE_REVIEW_COMMENT_PATH,
    methods: ['POST'],
    // The comment store is in memory; only reading the body can wait.
    budget: 'fast',
    handler: async io => {
      try {
        const sessionId = sessionIdFromUrl(io.url)
        if (!ownsSession(sessionId)) throw new ReviewCommentError('session-unavailable', 'The Claude session is unavailable.')
        const pathname = io.url.pathname
        if (pathname === CLAUDE_REVIEW_COMMENT_PATH) {
          const input = await readJson(io)
          const comment = store.add(sessionId, {
            path: input.path,
            line: input.line,
            startLine: input.startLine,
            side: input.side,
            text: input.text,
          })
          return { status: 200, value: { comment } }
        }
        if (pathname === `${CLAUDE_REVIEW_COMMENT_PATH}/clear`) {
          return { status: 200, value: { removed: store.drain(sessionId).length } }
        }
        if (pathname === `${CLAUDE_REVIEW_COMMENT_PATH}/remove`) {
          const input = await readJson(io)
          if (typeof input.id !== 'string' || input.id.length === 0 || input.id.length > 128) {
            throw new ReviewCommentError('invalid-request', 'The comment id is invalid.')
          }
          return { status: 200, value: { removed: store.remove(sessionId, input.id) } }
        }
        return { status: 404, value: { error: 'not found' } }
      } catch (error) {
        if (error instanceof ReviewCommentError) return { status: 409, value: { error: error.code, message: error.message } }
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'review-comment-unavailable', message: 'Review comments are unavailable.' } }
      }
    },
  })
}
