import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REVIEW_COMMENT_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import { ReviewCommentError, type ReviewCommentStore } from './review-comments.ts'

const MAX_BODY_BYTES = 16 * 1024
const MAX_SESSION_ID_CHARS = 1_024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new ReviewCommentError('body-too-large', 'The request body is too large.')
    chunks.push(buffer)
  }
  const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
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
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CLAUDE_REVIEW_COMMENT_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        const sessionId = sessionIdFromUrl(url)
        if (!ownsSession(sessionId)) throw new ReviewCommentError('session-unavailable', 'The Claude session is unavailable.')
        if (url.pathname === CLAUDE_REVIEW_COMMENT_PATH && req.method === 'POST') {
          const input = await readJson(req)
          const comment = store.add(sessionId, {
            path: input.path,
            line: input.line,
            startLine: input.startLine,
            side: input.side,
            text: input.text,
          })
          return json(res, 200, { comment })
        }
        if (url.pathname === `${CLAUDE_REVIEW_COMMENT_PATH}/clear` && req.method === 'POST') {
          return json(res, 200, { removed: store.drain(sessionId).length })
        }
        if (url.pathname === `${CLAUDE_REVIEW_COMMENT_PATH}/remove` && req.method === 'POST') {
          const input = await readJson(req)
          if (typeof input.id !== 'string' || input.id.length === 0 || input.id.length > 128) {
            throw new ReviewCommentError('invalid-request', 'The comment id is invalid.')
          }
          return json(res, 200, { removed: store.remove(sessionId, input.id) })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof ReviewCommentError) return json(res, 409, { error: error.code, message: error.message })
        if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid-json' })
        return json(res, 500, { error: 'review-comment-unavailable', message: 'Review comments are unavailable.' })
      }
    },
  }), 'dsh-claude: review comment route')
}
