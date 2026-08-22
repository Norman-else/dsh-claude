import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_SETUP_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new RepositorySetupError('body-too-large', 'The request body is too large.')
    chunks.push(buffer)
  }
  const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
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

function ndjsonHeaders(res: import('node:http').ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.flushHeaders?.()
}

function ndjson(res: import('node:http').ServerResponse, value: unknown): void {
  res.write(`${JSON.stringify(value)}\n`)
}

async function streamSetup(
  res: import('node:http').ServerResponse,
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

/** Register trusted browser routes for safe pre-session Git setup. */
export function registerRepositorySetupRoute(ctx: Context, service: RepositorySetupService): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CLAUDE_REPOSITORY_SETUP_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      try {
        if (pathname === `${CLAUDE_REPOSITORY_SETUP_PATH}/branches`) {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          const cwd = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cwd')
          if (cwd === null) throw new RepositorySetupError('invalid-request', 'The cwd query parameter is required.')
          return json(res, 200, await service.listBranches(cwd))
        }
        if (pathname === CLAUDE_REPOSITORY_SETUP_PATH) {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(req)
          if (typeof input.worktree !== 'boolean') throw new RepositorySetupError('invalid-request', 'The worktree field is required.')
          await streamSetup(res, service, input)
          return
        }
        if (pathname === `${CLAUDE_REPOSITORY_SETUP_PATH}/bind`) {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(req)
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
  }), 'dsh-claude: repository setup route')
}
