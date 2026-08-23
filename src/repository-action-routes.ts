import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_ACTION_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import {
  RepositoryActionError,
  type RepositoryActionKind,
  type RepositoryActionRequest,
  type RepositoryActionService,
} from './repository-actions.ts'

const MAX_BODY_BYTES = 16 * 1024
const MAX_SESSION_ID_CHARS = 1_024
const ACTIONS = new Set<RepositoryActionKind>(['commit', 'commit-push', 'create-pr'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new RepositoryActionError('body-too-large', 'The request body is too large.')
    chunks.push(buffer)
  }
  const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  if (value === undefined) throw new RepositoryActionError('invalid-request', 'The request body is invalid.')
  return value
}

function sessionId(url: URL): string {
  const value = url.searchParams.get('sessionId')
  if (value === null || value.length === 0 || value.length > MAX_SESSION_ID_CHARS) {
    throw new RepositoryActionError('invalid-session', 'The session is invalid.')
  }
  return value
}

function string(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new RepositoryActionError('invalid-request', `The ${key} field is required.`)
  return value
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new RepositoryActionError('invalid-request', `The ${key} field must be a string.`)
  return value
}

function actionRequest(input: Record<string, unknown>): RepositoryActionRequest {
  const action = input.action
  if (typeof action !== 'string' || !ACTIONS.has(action as RepositoryActionKind)
    || typeof input.includeUnstaged !== 'boolean') {
    throw new RepositoryActionError('invalid-request', 'The repository action is invalid.')
  }
  return {
    action: action as RepositoryActionKind,
    fingerprint: string(input, 'fingerprint'),
    message: string(input, 'message'),
    includeUnstaged: input.includeUnstaged,
    ...(optionalString(input, 'prTitle') === undefined ? {} : { prTitle: optionalString(input, 'prTitle')! }),
    ...(optionalString(input, 'prBody') === undefined ? {} : { prBody: optionalString(input, 'prBody')! }),
    ...(optionalString(input, 'baseBranch') === undefined ? {} : { baseBranch: optionalString(input, 'baseBranch')! }),
    ...(input.draft === undefined ? {} : typeof input.draft === 'boolean' ? { draft: input.draft } : (() => { throw new RepositoryActionError('invalid-request', 'The draft field must be a boolean.') })()),
  }
}

export function registerRepositoryActionRoute(
  ctx: Context,
  service: RepositoryActionService,
  cwdForSession: (sessionId: string) => string | undefined,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CLAUDE_REPOSITORY_ACTION_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        const id = sessionId(url)
        const cwd = cwdForSession(id)
        if (cwd === undefined) throw new RepositoryActionError('session-unavailable', 'The Claude session is unavailable.')
        if (url.pathname === `${CLAUDE_REPOSITORY_ACTION_PATH}/preview`) {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          return json(res, 200, await service.preview(cwd))
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_ACTION_PATH}/message`) {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(req)
          return json(res, 200, { message: await service.generateMessage(cwd, string(input, 'fingerprint')) })
        }
        if (url.pathname === CLAUDE_REPOSITORY_ACTION_PATH) {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          return json(res, 200, await service.execute(cwd, actionRequest(await readJson(req))))
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof RepositoryActionError) {
          return json(res, 409, {
            error: error.code,
            message: error.message,
            ...(error.commit === undefined ? {} : { commit: error.commit }),
          })
        }
        if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid-json' })
        return json(res, 500, { error: 'repository-action-unavailable', message: 'Repository action is unavailable.' })
      }
    },
  }), 'dsh-claude: repository action route')
}
