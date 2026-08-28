import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_FEEDBACK_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import { PullRequestFeedbackError, type PullRequestFeedbackService } from './pr-feedback.ts'

const MAX_SESSION_ID_CHARS = 1_024
const MAX_BODY_BYTES = 16 * 1024
const MAX_REPLY_CHARS = 2_000
const MAX_THREAD_ID_CHARS = 512
const MAX_MENTION_QUERY_CHARS = 64

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new PullRequestFeedbackError('body-too-large', 'The request body is too large.')
    chunks.push(buffer)
  }
  const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  if (value === undefined) throw new PullRequestFeedbackError('invalid-request', 'The request body is invalid.')
  return value
}

function replyBody(input: Record<string, unknown>): string {
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (body.length === 0 || body.length > MAX_REPLY_CHARS || body.includes('\0')) {
    throw new PullRequestFeedbackError('invalid-request', 'The reply body is invalid.')
  }
  return body
}

function commentId(input: Record<string, unknown>): number {
  const value = input.commentId
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PullRequestFeedbackError('invalid-request', 'The comment id is invalid.')
  }
  return value
}

function threadId(input: Record<string, unknown>): string {
  const value = input.threadId
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_THREAD_ID_CHARS) {
    throw new PullRequestFeedbackError('invalid-request', 'The thread id is invalid.')
  }
  return value
}

function sessionId(url: URL): string {
  const value = url.searchParams.get('sessionId')
  if (value === null || value.length === 0 || value.length > MAX_SESSION_ID_CHARS) {
    throw new PullRequestFeedbackError('invalid-session', 'The session is invalid.')
  }
  return value
}

function pullNumber(url: URL): number {
  const value = Number(url.searchParams.get('number'))
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000) {
    throw new PullRequestFeedbackError('invalid-request', 'The pull request number is invalid.')
  }
  return value
}

export function registerPullRequestFeedbackRoute(
  ctx: Context,
  service: PullRequestFeedbackService,
  cwdForSession: (sessionId: string) => string | undefined,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CLAUDE_REPOSITORY_FEEDBACK_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const reads = req.method === 'GET'
      const writes = req.method === 'POST'
      try {
        const cwd = cwdForSession(sessionId(url))
        if (cwd === undefined) throw new PullRequestFeedbackError('session-unavailable', 'The Claude session is unavailable.')
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/comments`) {
          if (!reads) return json(res, 405, { error: 'method not allowed' })
          return json(res, 200, { threads: await service.threads(cwd, pullNumber(url)) })
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/checks`) {
          if (!reads) return json(res, 405, { error: 'method not allowed' })
          return json(res, 200, { checks: await service.failingChecks(cwd, pullNumber(url)) })
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/mentionables`) {
          if (!reads) return json(res, 405, { error: 'method not allowed' })
          const query = (url.searchParams.get('q') ?? '').slice(0, MAX_MENTION_QUERY_CHARS)
          return json(res, 200, { users: await service.mentionables(cwd, query) })
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/reply`) {
          if (!writes) return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(req)
          const comment = await service.reply(cwd, pullNumber(url), commentId(input), replyBody(input))
          return json(res, 200, { comment })
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/resolve`) {
          if (!writes) return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(req)
          if (typeof input.resolved !== 'boolean') {
            throw new PullRequestFeedbackError('invalid-request', 'The resolved field is required.')
          }
          return json(res, 200, { resolved: await service.setResolved(cwd, threadId(input), input.resolved) })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof PullRequestFeedbackError) {
          return json(res, 409, { error: error.code, message: error.message })
        }
        if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid-json' })
        return json(res, 500, { error: 'pr-feedback-unavailable', message: 'Pull request feedback is unavailable.' })
      }
    },
  }), 'dsh-claude: pull request feedback route')
}
