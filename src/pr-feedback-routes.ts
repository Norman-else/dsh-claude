import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_FEEDBACK_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import { PullRequestFeedbackError, type PullRequestFeedbackService } from './pr-feedback.ts'

const MAX_SESSION_ID_CHARS = 1_024

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
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        const cwd = cwdForSession(sessionId(url))
        if (cwd === undefined) throw new PullRequestFeedbackError('session-unavailable', 'The Claude session is unavailable.')
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/comments`) {
          return json(res, 200, { comments: await service.comments(cwd, pullNumber(url)) })
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_FEEDBACK_PATH}/checks`) {
          return json(res, 200, { checks: await service.failingChecks(cwd, pullNumber(url)) })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof PullRequestFeedbackError) {
          return json(res, 409, { error: error.code, message: error.message })
        }
        return json(res, 500, { error: 'pr-feedback-unavailable', message: 'Pull request feedback is unavailable.' })
      }
    },
  }), 'dsh-claude: pull request feedback route')
}
