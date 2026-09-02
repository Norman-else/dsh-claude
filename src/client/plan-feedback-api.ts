import { CLAUDE_PLAN_FEEDBACK_PATH } from '../constants.ts'
import { PluginRequestError, pluginWrite } from './plugin-transport.ts'
import type { PlanNote } from '../plan-feedback.ts'

export type { PlanNote }

/** Why sending the notes failed, as a locale key the panel can render. */
export type PlanFeedbackFailure = 'planSettled' | 'planFeedbackFailed'

/** Send one plan back for changes. */
export async function sendPlanForChanges(sessionId: string, toolUseId: string, notes: readonly PlanNote[]): Promise<void> {
  try {
    await pluginWrite<unknown>(CLAUDE_PLAN_FEEDBACK_PATH, 'fast', undefined, {
      query: { sessionId },
      json: { toolUseId, notes },
    })
  } catch (error) {
    // A settled plan is the one failure worth naming: the notes are still in
    // the box, and the reason they did not land is that the approval dialog
    // answered first.
    const settled = error instanceof PluginRequestError && error.reason === 'http' && error.status === 409
    throw new Error(settled ? 'planSettled' satisfies PlanFeedbackFailure : 'planFeedbackFailed' satisfies PlanFeedbackFailure)
  }
}
