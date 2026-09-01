import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_SETUP_PATH } from './constants.ts'
import { json, registerPluginRoute, type PluginRouteIo } from './http.ts'
import {
  RepositorySetupError,
  type RepositorySetupResult,
  type RepositorySetupService,
  type RepositorySetupStage,
} from './repository-setup.ts'

const MAX_BODY_BYTES = 16 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function readJson(io: PluginRouteIo): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await io.body<unknown>(MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    throw new RepositorySetupError('body-too-large', 'The request body is too large.')
  }
  const value = record(parsed)
  if (value === undefined) throw new RepositorySetupError('invalid-request', 'The request body is invalid.')
  return value
}

function string(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new RepositorySetupError('invalid-request', `The ${key} field is required.`)
  return value
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new RepositorySetupError('invalid-request', `The ${key} field must be a string.`)
  return value
}

function ndjsonHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.flushHeaders?.()
}

function ndjson(res: ServerResponse, value: unknown): void {
  res.write(`${JSON.stringify(value)}\n`)
}

// `RepositorySetupService.setup` takes no signal, so the route's disconnect
// abort cannot reach the Git work it drives; the stream registration is still
// what bounds how many of these may be live at once.
async function streamSetup(
  res: ServerResponse,
  service: RepositorySetupService,
  input: Record<string, unknown>,
): Promise<void> {
  ndjsonHeaders(res)
  let ended = false
  try {
    const result: RepositorySetupResult = await service.setup(
      string(input, 'cwd'),
      string(input, 'branch'),
      input.worktree as boolean,
      optionalString(input, 'branchName'),
      (stage: RepositorySetupStage) => { if (!ended) ndjson(res, { type: 'progress', stage }) },
      optionalString(input, 'intent'),
    )
    ndjson(res, { type: 'complete', result })
  } catch (error) {
    const setupError = error instanceof RepositorySetupError ? error : undefined
    ndjson(res, {
      type: 'error',
      code: setupError?.code ?? 'repository-setup-unavailable',
      message: setupError?.message ?? 'Repository setup is unavailable.',
    })
  } finally {
    ended = true
    res.end()
  }
}

/** Register trusted browser routes for safe pre-session Git setup.
 *
 *  The prefix is registered as a stream because the setup POST holds its
 *  connection open for the whole worktree build; the short sibling paths ride
 *  the same registration and answer with `json` before releasing it. */
export function registerRepositorySetupRoute(ctx: Context, service: RepositorySetupService): void {
  registerPluginRoute(ctx, {
    mode: 'stream',
    kind: 'prefix',
    path: CLAUDE_REPOSITORY_SETUP_PATH,
    methods: ['GET', 'POST'],
    maxConcurrent: 2,
    // Only the branch paths name their checkout in the URL; the setup POST
    // carries it in the body, so it keys on its path alone and a reopen
    // supersedes the response it is replacing.
    streamKey: url => `${url.pathname}?${url.searchParams.get('cwd') ?? url.searchParams.get('branch') ?? ''}`,
    handler: async (res, io) => {
      const pathname = io.url.pathname
      try {
        // Not a GET: --prune rewrites this checkout's remote-tracking refs.
        if (pathname === `${CLAUDE_REPOSITORY_SETUP_PATH}/branches/refresh`) {
          if (io.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(io)
          return json(res, 200, await service.refreshBranches(string(input, 'cwd')))
        }
        if (pathname === `${CLAUDE_REPOSITORY_SETUP_PATH}/branches`) {
          if (io.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          const cwd = io.url.searchParams.get('cwd')
          if (cwd === null) throw new RepositorySetupError('invalid-request', 'The cwd query parameter is required.')
          return json(res, 200, await service.listBranches(cwd))
        }
        if (pathname === CLAUDE_REPOSITORY_SETUP_PATH) {
          if (io.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(io)
          if (typeof input.worktree !== 'boolean') throw new RepositorySetupError('invalid-request', 'The worktree field is required.')
          await streamSetup(res, service, input)
          return
        }
        if (pathname === `${CLAUDE_REPOSITORY_SETUP_PATH}/cleanup`) {
          if (io.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(io)
          return json(res, 200, await service.cleanupMerged(string(input, 'path'), string(input, 'baseBranch')))
        }
        if (pathname === `${CLAUDE_REPOSITORY_SETUP_PATH}/bind`) {
          if (io.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(io)
          await service.bindLease(string(input, 'leaseId'), string(input, 'sessionId'))
          return json(res, 200, { ok: true })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof RepositorySetupError) return json(res, 409, { error: error.code, message: error.message })
        if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid json' })
        return json(res, 500, { error: 'repository setup unavailable' })
      }
    },
  })
}
