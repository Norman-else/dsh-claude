import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_TASK_STOP_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import type { ClaudeTaskInfo } from './events.ts'
import type { ClaudeStopTaskOutcome } from './supervisor.ts'

const MAX_BODY_BYTES = 4 * 1024
const MAX_SESSION_ID_CHARS = 1_024
const MAX_TASK_ID_CHARS = 256

export interface ClaudeTaskAccess {
  /** Tasks this session's live process reported, or an empty list for a
   *  session with no process to ask. */
  tasksFor: (sessionId: string) => readonly ClaudeTaskInfo[]
  /** Stop one task the session's live process owns. */
  stopTask: (sessionId: string, taskId: string) => Promise<ClaudeStopTaskOutcome>
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

/** `POST <path>` with `{ sessionId, taskId }`: end one background shell or
 *  subagent the session's live process reported.
 *
 *  Claude keeps background work running across turns, and the CLI's own way to
 *  stop it is a keyboard path a browser does not have. The board is the only
 *  place that knows which tasks exist, so the request is checked against it:
 *  an unknown or already-settled task is a conflict, not a silent success. */
export function registerClaudeTaskRoute(ctx: Context, access: ClaudeTaskAccess): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_TASK_STOP_PATH,
    methods: ['POST'],
    // One control request over an already-running process.
    budget: 'fast',
    handler: async io => {
      try {
        const input = await readJson(io)
        const sessionId = input?.sessionId
        const taskId = input?.taskId
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS
          || typeof taskId !== 'string' || taskId.length === 0 || taskId.length > MAX_TASK_ID_CHARS) {
          return { status: 400, value: { error: 'invalid-request' } }
        }
        const task = access.tasksFor(sessionId).find(candidate => candidate.taskId === taskId)
        if (task === undefined) return { status: 409, value: { error: 'task-unavailable' } }
        // The board is authoritative over the task's own status, so a task that
        // already settled is refused here rather than sent to a CLI that would
        // answer for a task id it no longer holds.
        if (task.status !== 'running') return { status: 409, value: { error: 'task-settled' } }
        const outcome = await access.stopTask(sessionId, taskId)
        if (outcome !== 'stopped') return { status: 409, value: { error: 'task-unavailable' } }
        return { status: 200, value: { ok: true } }
      } catch (error) {
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'task-unavailable' } }
      }
    },
  })
}
