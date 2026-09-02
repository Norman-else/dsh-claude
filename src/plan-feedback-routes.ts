import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_PLAN_FEEDBACK_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import { PlanFeedbackError, planNotesOf, type PlanFeedbackGate } from './plan-feedback.ts'

const MAX_BODY_BYTES = 64 * 1024
const MAX_SESSION_ID_CHARS = 1_024
const MAX_TOOL_USE_ID_CHARS = 256

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(io: PluginRouteIo): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await io.body<unknown>(MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    throw new PlanFeedbackError('body-too-large', 'The request body is too large.')
  }
  const value = record(parsed)
  if (value === undefined) throw new PlanFeedbackError('invalid-request', 'The request body is invalid.')
  return value
}

/** Send one plan back for changes.
 *
 *  Unary rather than a stream: the panel hands over what the reviewer wrote
 *  and the turn carries on in the transcript it was already watching. Answers
 *  409 when nothing is waiting, which is what the panel shows if the approval
 *  dialog was answered while the reviewer was still typing. */
export function registerPlanFeedbackRoute(
  ctx: Context,
  gate: PlanFeedbackGate,
  ownsSession: (sessionId: string) => boolean,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    budget: 'fast',
    kind: 'exact',
    path: CLAUDE_PLAN_FEEDBACK_PATH,
    methods: ['POST'],
    handler: async io => {
      try {
        const sessionId = io.url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS) {
          return { status: 400, value: { error: 'invalid-session' } }
        }
        if (!ownsSession(sessionId)) return { status: 409, value: { error: 'session-unavailable' } }
        const body = await readJson(io)
        const toolUseId = body.toolUseId
        if (typeof toolUseId !== 'string' || toolUseId.length === 0 || toolUseId.length > MAX_TOOL_USE_ID_CHARS) {
          return { status: 400, value: { error: 'invalid-request' } }
        }
        const notes = planNotesOf(body.notes)
        // A plan that is no longer open was decided in the dialog while the
        // reviewer was writing; saying so beats silently dropping their notes.
        if (!gate.submit(toolUseId, notes)) return { status: 409, value: { error: 'plan-settled' } }
        return { status: 200, value: { ok: true } }
      } catch (error) {
        if (error instanceof PlanFeedbackError) return { status: 400, value: { error: error.code, message: error.message } }
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'plan-feedback-unavailable' } }
      }
    },
  })
}
