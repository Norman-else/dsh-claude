import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_FEEDBACK_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import { PullRequestFeedbackError, type PullRequestFeedbackService } from './pr-feedback.ts'

const MAX_SESSION_ID_CHARS = 1_024
const MAX_BODY_BYTES = 16 * 1024
const MAX_REPLY_CHARS = 2_000
const MAX_THREAD_ID_CHARS = 512
const MAX_MENTION_QUERY_CHARS = 64

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(io: PluginRouteIo): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await io.body<unknown>(MAX_BODY_BYTES)
  } catch (error) {
    // Malformed JSON keeps its own 400; the cap is the only other refusal the
    // transport raises, and the panel already knows that code.
    if (error instanceof SyntaxError) throw error
    throw new PullRequestFeedbackError('body-too-large', 'The request body is too large.')
  }
  const value = record(parsed)
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

/** Every arm shells out to `gh`, so the whole prefix carries the network budget. */
export function registerPullRequestFeedbackRoute(
  ctx: Context,
  service: PullRequestFeedbackService,
  cwdForSession: (sessionId: string) => string | undefined,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'prefix',
    path: CLAUDE_REPOSITORY_FEEDBACK_PATH,
    methods: ['GET', 'POST'],
    budget: 'remote',
    handler: async io => {
      const url = io.url
      const reads = io.method === 'GET'
      const writes = io.method === 'POST'
      try {
        const cwd = cwdForSession(sessionId(url))
        if (cwd === undefined) throw new PullRequestFeedbackError('session-unavailable', 'The Claude session is unavailable.')
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/comments`) {
          if (!reads) return { status: 405, value: { error: 'method not allowed' } }
          return { status: 200, value: { threads: await service.threads(cwd, pullNumber(url)) } }
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/checks`) {
          if (!reads) return { status: 405, value: { error: 'method not allowed' } }
          return { status: 200, value: { checks: await service.failingChecks(cwd, pullNumber(url), io.signal) } }
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/mentionables`) {
          if (!reads) return { status: 405, value: { error: 'method not allowed' } }
          const query = (url.searchParams.get('q') ?? '').slice(0, MAX_MENTION_QUERY_CHARS)
          return { status: 200, value: { users: await service.mentionables(cwd, query) } }
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/reply`) {
          if (!writes) return { status: 405, value: { error: 'method not allowed' } }
          const input = await readJson(io)
          const comment = await service.reply(cwd, pullNumber(url), commentId(input), replyBody(input))
          return { status: 200, value: { comment } }
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/resolve`) {
          if (!writes) return { status: 405, value: { error: 'method not allowed' } }
          const input = await readJson(io)
          if (typeof input.resolved !== 'boolean') {
            throw new PullRequestFeedbackError('invalid-request', 'The resolved field is required.')
          }
          return { status: 200, value: { resolved: await service.setResolved(cwd, threadId(input), input.resolved) } }
        }
        return { status: 404, value: { error: 'not found' } }
      } catch (error) {
        if (error instanceof PullRequestFeedbackError) {
          return { status: 409, value: { error: error.code, message: error.message } }
        }
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'pr-feedback-unavailable', message: 'Pull request feedback is unavailable.' } }
      }
    },
  })
}
