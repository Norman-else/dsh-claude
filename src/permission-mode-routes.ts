import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_PERMISSION_MODE_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import { isClaudePermissionMode, SANDBOX_BY_CLAUDE_MODE, type ClaudePermissionMode, type DshSandboxMode } from './permission-mode.ts'
import type { ClaudeSidecarRepository } from './sidecar.ts'

const MAX_BODY_BYTES = 4 * 1024
const MAX_SESSION_ID_CHARS = 1_024

export interface ClaudePermissionModeAccess {
  /** Whether the session is one this plugin drives. */
  ownsSession: (sessionId: string) => boolean
  /** Whether a turn is in flight; the mode it started under is the mode it keeps. */
  busy: (sessionId: string) => boolean
  /** Put the Host's own knobs (sandbox mode, approval policy) on the preset
   *  the mode is carried on. Answers whether the Host took it: a Host whose
   *  preset table lacks that entry, or that mounts no preset service at all,
   *  leaves Claude to enforce the mode on its own. */
  applyHostPreset: (sessionId: string, sandbox: DshSandboxMode) => Promise<boolean>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(io: PluginRouteIo): Promise<Record<string, unknown> | undefined> {
  try {
    return record(await io.body<unknown>(MAX_BODY_BYTES))
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    return undefined
  }
}

/** `POST <path>` with `{ sessionId, mode }`: make `mode` the session's Claude
 *  permission mode from its next turn, and move the Host's access preset
 *  with it. The plugin's record lands first: it is what the next turn reads,
 *  and a Host that declines the preset changes nothing about that. */
export function registerClaudePermissionModeRoute(
  ctx: Context,
  sidecar: ClaudeSidecarRepository,
  access: ClaudePermissionModeAccess,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_PERMISSION_MODE_PATH,
    methods: ['POST'],
    // One sidecar write and two session-log appends.
    budget: 'fast',
    handler: async io => {
      try {
        const input = await readJson(io)
        const sessionId = input?.sessionId
        const mode = input?.mode
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS
          || !isClaudePermissionMode(mode)) {
          return { status: 400, value: { error: 'invalid-request' } }
        }
        if (!access.ownsSession(sessionId)) return { status: 409, value: { error: 'session-unavailable' } }
        if (access.busy(sessionId)) return { status: 409, value: { error: 'session-busy' } }
        await sidecar.writePermissionMode(sessionId, mode)
        const sandbox = SANDBOX_BY_CLAUDE_MODE[mode]
        const hostSynced = await access.applyHostPreset(sessionId, sandbox).catch((error: unknown) => {
          ctx.logger?.warn?.(`dsh-claude: Host preset ${sandbox} not applied for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
          return false
        })
        return { status: 200, value: { mode, sandbox, hostSynced } satisfies ClaudePermissionModeResult }
      } catch (error) {
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        throw error
      }
    },
  })
}

export interface ClaudePermissionModeResult {
  readonly mode: ClaudePermissionMode
  readonly sandbox: DshSandboxMode
  readonly hostSynced: boolean
}
