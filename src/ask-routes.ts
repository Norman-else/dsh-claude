import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AskError, type AskPreferences, type AskRequest, type AskService } from './ask.ts'
import { CLAUDE_ASK_PATH } from './constants.ts'
import { json, registerPluginRoute } from './http.ts'

const MAX_BODY_BYTES = 128 * 1024
const MAX_SESSION_ID_CHARS = 1_024
/** Two sessions may await an answer at once; a third evicts the oldest. */
const MAX_CONCURRENT_ASKS = 2

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
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

/** A stream route rather than a unary one: the answer is written as it arrives,
 *  so the deadline stays where the work is — `ASK_TIMEOUT_MS` inside the
 *  service, fused there with the disconnect signal — instead of a route budget
 *  that would cut a legitimate long answer off mid-sentence. */
export function registerAskRoute(
  ctx: Context,
  service: AskService,
  cwdForSession: (sessionId: string) => string | undefined,
  preferencesFor: (sessionId: string) => AskPreferences | undefined,
): void {
  registerPluginRoute(ctx, {
    mode: 'stream',
    kind: 'exact',
    path: CLAUDE_ASK_PATH,
    methods: ['POST'],
    maxConcurrent: MAX_CONCURRENT_ASKS,
    streamKey: url => url.searchParams.get('sessionId') ?? '',
    handler: async (res, io) => {
      let cwd: string
      let request: AskRequest
      let sessionId: string
      try {
        const value = io.url.searchParams.get('sessionId')
        if (value === null || value.length === 0 || value.length > MAX_SESSION_ID_CHARS) throw new AskError('invalid-session', 'The session is invalid.')
        sessionId = value
        const resolved = cwdForSession(sessionId)
        if (resolved === undefined) throw new AskError('session-unavailable', 'The Claude session is unavailable.')
        cwd = resolved
        const body = record(await io.body(MAX_BODY_BYTES))
        if (body === undefined) throw new AskError('invalid-request', 'The request body is invalid.')
        request = askRequest(body)
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
      try {
        await service.ask(cwd, request, preferencesFor(sessionId) ?? {}, event => { ndjson(res, event.type === 'text' ? { type: 'delta', text: event.text } : event) }, io.signal)
        ndjson(res, { type: 'done' })
      } catch (error) {
        ndjson(res, {
          type: 'error',
          code: error instanceof AskError ? error.code : 'ask-unavailable',
          message: error instanceof AskError ? error.message : 'The question could not be answered.',
        })
      }
    },
  })
}
