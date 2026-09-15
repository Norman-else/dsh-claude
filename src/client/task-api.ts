import { CLAUDE_TASK_STOP_PATH } from '../constants.ts'
import { PluginRequestError, pluginWrite } from './plugin-transport.ts'

/** End one background task — a detached shell or a subagent — that the
 *  session's live Claude process owns.
 *
 *  The answer is a refusal, not a failure, when the task is gone: the board
 *  moved on while the button was being pressed, and the card will say so. The
 *  transport reports a Host still running the previously loaded bundle as
 *  `route-missing`, which is a stale process rather than a failed stop. */
export async function stopClaudeTask(sessionId: string, taskId: string): Promise<void> {
  try {
    await pluginWrite<unknown>(CLAUDE_TASK_STOP_PATH, 'fast', undefined, { json: { sessionId, taskId } })
  } catch (error) {
    if (!(error instanceof PluginRequestError)) throw error
    throw new Error(error.code ?? error.reason)
  }
}
