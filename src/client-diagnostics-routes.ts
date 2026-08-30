import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_CLIENT_DIAGNOSTICS_PATH } from './constants.ts'
import { redactText } from './events.ts'
import { json, trustedRequest } from './http.ts'

/** Enough for a message plus a trimmed stack; the client caps its own volume. */
const MAX_DIAGNOSTIC_BYTES = 8 * 1024
const MAX_DETAIL_CHARS = 2_000
const MAX_KIND_CHARS = 60

async function readBody(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_DIAGNOSTIC_BYTES) throw new Error('diagnostic too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** `POST <path>` with `{ kind, detail }`: write one renderer finding to the Host log.
 *
 *  The renderer has no other way to speak. A Slot entry that throws is caught
 *  by the Host's Slot system and dropped, the shipped Desktop opens no
 *  DevTools, and startup still reports `rendererStatus: "healthy"` — so a
 *  plugin whose UI died silently is indistinguishable from a working one.
 *  Every finding here is data written by this package's own client half, but
 *  it is still bounded and redacted like any other untrusted input. */
export function registerClaudeClientDiagnosticsRoute(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_CLIENT_DIAGNOSTICS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        const body = await readBody(req) as { kind?: unknown; detail?: unknown } | null
        const kind = typeof body?.kind === 'string' ? body.kind.slice(0, MAX_KIND_CHARS) : 'unknown'
        const detail = typeof body?.detail === 'string' ? body.detail : ''
        if (detail === '') return json(res, 400, { error: 'invalid-request' })
        ctx.logger.warn(`dsh-claude client [${kind}]: ${redactText(detail, MAX_DETAIL_CHARS)}`)
        return json(res, 200, { ok: true })
      } catch (error) {
        if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid-json' })
        return json(res, 400, { error: 'invalid-request' })
      }
    },
  }), 'dsh-claude: client diagnostics route')
}
