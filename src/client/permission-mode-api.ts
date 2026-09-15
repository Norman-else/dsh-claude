import { CLAUDE_PERMISSION_MODE_PATH } from '../constants.ts'
import { isClaudePermissionMode, type ClaudePermissionMode, type DshSandboxMode } from '../permission-mode.ts'
import { pluginWrite } from './plugin-transport.ts'

export interface ClaudePermissionModeOutcome {
  readonly mode: ClaudePermissionMode
  readonly sandbox: DshSandboxMode
  /** False when the Host kept its own access preset where it was; Claude
   *  still runs the mode, the Host's selector just does not say so. */
  readonly hostSynced: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Make `mode` the session's Claude permission mode from its next turn. */
export async function setClaudePermissionMode(sessionId: string, mode: ClaudePermissionMode, signal?: AbortSignal): Promise<ClaudePermissionModeOutcome> {
  const value = record(await pluginWrite<unknown>(CLAUDE_PERMISSION_MODE_PATH, 'fast', signal, { json: { sessionId, mode } }))
  if (value === undefined || !isClaudePermissionMode(value.mode) || typeof value.sandbox !== 'string' || typeof value.hostSynced !== 'boolean') {
    throw new Error('Invalid permission mode result.')
  }
  return { mode: value.mode, sandbox: value.sandbox as DshSandboxMode, hostSynced: value.hostSynced }
}
