import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_BACKGROUND_TASK_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'

const MAX_BODY_BYTES = 4 * 1024
const MAX_ID_CHARS = 1_024

export type ClaudeBackgroundOutcome = 'moved' | 'not-running' | 'unavailable'

export interface ClaudeBackgroundTaskAccess {
  /** Move one running root tool call of a plugin-owned session to the background. */
  background: (sessionId: string, toolUseId: string) => Promise<ClaudeBackgroundOutcome>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS ? value : undefined
}

async function readJson(io: PluginRouteIo): Promise<Record<string, unknown> | undefined> {
  try {
    return record(await io.body<unknown>(MAX_BODY_BYTES))
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    return undefined
  }
}

/** `POST <path>` with `{ sessionId, toolUseId }`: the Ctrl+B of the terminal
 *  for one blocking Bash call. Claude gets a "running in the background" result
 *  at once and the command joins the Host job list. */
export function registerClaudeBackgroundTaskRoute(ctx: Context, access: ClaudeBackgroundTaskAccess): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_BACKGROUND_TASK_PATH,
    methods: ['POST'],
    budget: 'fast',
    handler: async io => {
      try {
        const input = await readJson(io)
        const sessionId = id(input?.sessionId)
        const toolUseId = id(input?.toolUseId)
        if (sessionId === undefined || toolUseId === undefined) return { status: 400, value: { error: 'invalid-request' } }
        const outcome = await access.background(sessionId, toolUseId)
        return outcome === 'moved' ? { status: 200, value: { outcome } } : { status: 409, value: { error: outcome } }
      } catch (error) {
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'background-unavailable' } }
      }
    },
  })
}
