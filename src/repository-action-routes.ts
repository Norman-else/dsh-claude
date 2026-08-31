import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_ACTION_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import {
  RepositoryActionError,
  type RepositoryActionKind,
  type RepositoryActionRequest,
  type RepositoryMergeMethod,
  type RepositoryActionService,
} from './repository-actions.ts'

const MAX_BODY_BYTES = 16 * 1024
const MAX_SESSION_ID_CHARS = 1_024
const ACTIONS = new Set<RepositoryActionKind>(['commit', 'commit-push', 'push', 'create-pr', 'merge-pr', 'update-branch'])

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
    throw new RepositoryActionError('body-too-large', 'The request body is too large.')
  }
  const value = record(parsed)
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
    message: action === 'push' || action === 'merge-pr' || action === 'update-branch' ? optionalString(input, 'message') ?? '' : string(input, 'message'),
    includeUnstaged: input.includeUnstaged,
    ...(optionalString(input, 'prTitle') === undefined ? {} : { prTitle: optionalString(input, 'prTitle')! }),
    ...(optionalString(input, 'prBody') === undefined ? {} : { prBody: optionalString(input, 'prBody')! }),
    ...(optionalString(input, 'baseBranch') === undefined ? {} : { baseBranch: optionalString(input, 'baseBranch')! }),
    ...(input.draft === undefined ? {} : typeof input.draft === 'boolean' ? { draft: input.draft } : (() => { throw new RepositoryActionError('invalid-request', 'The draft field must be a boolean.') })()),
    ...(input.mergeMethod === undefined
      ? {}
      : input.mergeMethod === 'merge' || input.mergeMethod === 'squash' || input.mergeMethod === 'rebase'
        ? { mergeMethod: input.mergeMethod as RepositoryMergeMethod }
        : (() => { throw new RepositoryActionError('invalid-request', 'The mergeMethod field is invalid.') })()),
  }
}

/** One prefix serves the local-Git preview and the POST arms that push, open
 *  and merge pull requests, so the registration takes the wider of the two
 *  budgets: a `remote` arm cut short at the `git` deadline would abandon work
 *  that had already reached GitHub. */
export function registerRepositoryActionRoute(
  ctx: Context,
  service: RepositoryActionService,
  cwdForSession: (sessionId: string) => string | undefined,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'prefix',
    path: CLAUDE_REPOSITORY_ACTION_PATH,
    methods: ['GET', 'POST'],
    budget: 'remote',
    handler: async io => {
      const url = io.url
      try {
        const id = sessionId(url)
        const cwd = cwdForSession(id)
        if (cwd === undefined) throw new RepositoryActionError('session-unavailable', 'The Claude session is unavailable.')
        if (url.pathname === `${CLAUDE_REPOSITORY_ACTION_PATH}/preview`) {
          if (io.method !== 'GET') return { status: 405, value: { error: 'method not allowed' } }
          return { status: 200, value: await service.preview(cwd) }
        }
        if (url.pathname === `${CLAUDE_REPOSITORY_ACTION_PATH}/message`) {
          if (io.method !== 'POST') return { status: 405, value: { error: 'method not allowed' } }
          const input = await readJson(io)
          return { status: 200, value: { message: await service.generateMessage(cwd, string(input, 'fingerprint')) } }
        }
        if (url.pathname === CLAUDE_REPOSITORY_ACTION_PATH) {
          if (io.method !== 'POST') return { status: 405, value: { error: 'method not allowed' } }
          return { status: 200, value: await service.execute(cwd, actionRequest(await readJson(io))) }
        }
        return { status: 404, value: { error: 'not found' } }
      } catch (error) {
        if (error instanceof RepositoryActionError) {
          return {
            status: 409,
            value: {
              error: error.code,
              message: error.message,
              ...(error.commit === undefined ? {} : { commit: error.commit }),
            },
          }
        }
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'repository-action-unavailable', message: 'Repository action is unavailable.' } }
      }
    },
  })
}
