import { CLAUDE_BACKGROUND_TASK_PATH } from '../constants.ts'
import { PluginRequestError, pluginWrite } from './plugin-transport.ts'

/** Move one running Bash call to the background; resolves with the Host's
 *  answer code (`moved`, `not-running`, `unavailable`) rather than throwing
 *  for the expected refusals, so a card can just show what happened. */
export async function backgroundToolCall(sessionId: string, toolUseId: string): Promise<string> {
  try {
    const answer = await pluginWrite<unknown>(CLAUDE_BACKGROUND_TASK_PATH, 'fast', undefined, { json: { sessionId, toolUseId } })
    return typeof (answer as { outcome?: unknown } | undefined)?.outcome === 'string' ? (answer as { outcome: string }).outcome : 'moved'
  } catch (error) {
    if (!(error instanceof PluginRequestError)) throw error
    return error.code ?? error.reason
  }
}
