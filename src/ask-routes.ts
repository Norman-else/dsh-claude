import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AskError, type AskPreferences, type AskRequest, type AskService } from './ask.ts'
import { CLAUDE_ASK_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'

const MAX_BODY_BYTES = 128 * 1024
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
    if (size > MAX_BODY_BYTES) throw new AskError('body-too-large', 'The request body is too large.')
    chunks.push(buffer)
  }
  const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  if (value === undefined) throw new AskError('invalid-request', 'The request body is invalid.')
  return value
}

function askRequest(input: Record<string, unknown>): AskRequest {
  if (typeof input.selection !== 'string' || typeof input.question !== 'string' || (input.context !== undefined && typeof input.context !== 'string')) {
    throw new AskError('invalid-request', 'The selection and question fields are required.')
  }
  return { selection: input.selection, question: input.question, ...(typeof input.context === 'string' ? { context: input.context } : {}) }
}

function ndjson(res: ServerResponse, value: unknown): void {
  res.write(`${JSON.stringify(value)}\n`)
}

export function registerAskRoute(
  ctx: Context,
  service: AskService,
  cwdForSession: (sessionId: string) => string | undefined,
  preferencesFor: (sessionId: string) => AskPreferences | undefined,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_ASK_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      let cwd: string
      let request: AskRequest
      let sessionId: string
      try {
        const value = url.searchParams.get('sessionId')
        if (value === null || value.length === 0 || value.length > MAX_SESSION_ID_CHARS) throw new AskError('invalid-session', 'The session is invalid.')
        sessionId = value
        const resolved = cwdForSession(sessionId)
        if (resolved === undefined) throw new AskError('session-unavailable', 'The Claude session is unavailable.')
        cwd = resolved
        request = askRequest(await readJson(req))
      } catch (error) {
        if (error instanceof AskError) return json(res, 409, { error: error.code, message: error.message })
        if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid-json' })
        return json(res, 500, { error: 'ask-unavailable', message: 'The question could not be sent.' })
      }
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.flushHeaders?.()
      const controller = new AbortController()
      req.on('close', () => { controller.abort() })
      try {
        await service.ask(cwd, request, preferencesFor(sessionId) ?? {}, text => { ndjson(res, { type: 'delta', text }) }, controller.signal)
        ndjson(res, { type: 'done' })
      } catch (error) {
        ndjson(res, {
          type: 'error',
          code: error instanceof AskError ? error.code : 'ask-unavailable',
          message: error instanceof AskError ? error.message : 'The question could not be answered.',
        })
      } finally {
        res.end()
      }
    },
  }), 'dsh-claude: ask route')
}
