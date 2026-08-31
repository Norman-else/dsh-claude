import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REWIND_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
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

/** An oversized body fails the same field checks as a missing one; only
 *  malformed JSON is worth reporting separately. */
async function readJson(io: PluginRouteIo): Promise<Record<string, unknown> | undefined> {
  try {
    return record(await io.body<unknown>(MAX_BODY_BYTES))
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    return undefined
  }
}

/** `POST <path>` with `{ sessionId, seq }`: hide that surface event and every
 *  later one, and arm Claude to resume before the turn it opened. */
export function registerClaudeRewindRoute(
  ctx: Context,
  sidecar: ClaudeSidecarRepository,
  access: ClaudeRewindSessionAccess,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_REWIND_PATH,
    methods: ['POST'],
    // The session log is already in memory; the sidecar write is local.
    budget: 'git',
    handler: async io => {
      try {
        const input = await readJson(io)
        const sessionId = input?.sessionId
        const seq = input?.seq
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS
          || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
          return { status: 400, value: { error: 'invalid-request' } }
        }
        const events = access.eventsFor(sessionId)
        if (events === undefined) return { status: 409, value: { error: 'session-unavailable' } }
        if (access.busy(sessionId)) return { status: 409, value: { error: 'session-busy' } }
        const current = (await sidecar.read(sessionId)).rewind ?? EMPTY_REWIND_STATE
        const planned = planRewind(current, events, seq)
        if (planned === undefined) return { status: 409, value: { error: 'seq-unavailable' } }
        await sidecar.writeRewind(sessionId, planned)
        await access.reset(sessionId)
        return { status: 200, value: { ranges: planned.ranges } }
      } catch (error) {
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'rewind-unavailable' } }
      }
    },
  })
}
