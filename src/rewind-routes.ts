import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REWIND_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import { EMPTY_REWIND_STATE, planRewind } from './rewind.ts'
import type { ClaudeSidecarRepository } from './sidecar.ts'

const MAX_BODY_BYTES = 4 * 1024
const MAX_SESSION_ID_CHARS = 1_024

export interface ClaudeRewindSessionAccess {
  /** The session log of one plugin-owned session, or undefined for any other. */
  eventsFor: (sessionId: string) => readonly SessionEvent[] | undefined
  /** Whether a turn is in flight; rewinding one would cut it mid-run. */
  busy: (sessionId: string) => boolean
  /** Drop the live Claude process so the next turn resumes at the fork target. */
  reset: (sessionId: string) => Promise<void>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}

/** `POST <path>` with `{ sessionId, seq }`: hide that surface event and every
 *  later one, and arm Claude to resume before the turn it opened. */
export function registerClaudeRewindRoute(
  ctx: Context,
  sidecar: ClaudeSidecarRepository,
  access: ClaudeRewindSessionAccess,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_REWIND_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        const input = await readJson(req)
        const sessionId = input?.sessionId
        const seq = input?.seq
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS
          || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
          return json(res, 400, { error: 'invalid-request' })
        }
        const events = access.eventsFor(sessionId)
        if (events === undefined) return json(res, 409, { error: 'session-unavailable' })
        if (access.busy(sessionId)) return json(res, 409, { error: 'session-busy' })
        const current = (await sidecar.read(sessionId)).rewind ?? EMPTY_REWIND_STATE
        const planned = planRewind(current, events, seq)
        if (planned === undefined) return json(res, 409, { error: 'seq-unavailable' })
        await sidecar.writeRewind(sessionId, planned)
        await access.reset(sessionId)
        return json(res, 200, { ranges: planned.ranges })
      } catch (error) {
        if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid-json' })
        return json(res, 500, { error: 'rewind-unavailable' })
      }
    },
  }), 'dsh-claude: rewind route')
}
