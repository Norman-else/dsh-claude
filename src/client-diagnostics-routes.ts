import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_CLIENT_DIAGNOSTICS_PATH } from './constants.ts'
import { redactText } from './events.ts'
import { registerPluginRoute } from './http.ts'

/** Enough for a message plus a trimmed stack; the client caps its own volume. */
const MAX_DIAGNOSTIC_BYTES = 8 * 1024
const MAX_DETAIL_CHARS = 2_000
const MAX_KIND_CHARS = 60

/** `POST <path>` with `{ kind, detail }`: write one renderer finding to the Host log.
 *
 *  The renderer has no other way to speak. A Slot entry that throws is caught
 *  by the Host's Slot system and dropped, the shipped Desktop opens no
 *  DevTools, and startup still reports `rendererStatus: "healthy"` — so a
 *  plugin whose UI died silently is indistinguishable from a working one.
 *  Every finding here is data written by this package's own client half, but
 *  it is still bounded and redacted like any other untrusted input. */
export function registerClaudeClientDiagnosticsRoute(ctx: Context): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_CLIENT_DIAGNOSTICS_PATH,
    methods: ['POST'],
    budget: 'fast',
    handler: async io => {
      try {
        const body = await io.body<{ kind?: unknown; detail?: unknown } | null>(MAX_DIAGNOSTIC_BYTES)
        const kind = typeof body?.kind === 'string' ? body.kind.slice(0, MAX_KIND_CHARS) : 'unknown'
        const detail = typeof body?.detail === 'string' ? body.detail : ''
        if (detail === '') return { status: 400, value: { error: 'invalid-request' } }
        ctx.logger.warn(`dsh-claude client [${kind}]: ${redactText(detail, MAX_DETAIL_CHARS)}`)
        return { status: 200, value: { ok: true } }
      } catch (error) {
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 400, value: { error: 'invalid-request' } }
      }
    },
  })
}
