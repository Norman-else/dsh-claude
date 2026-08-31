import { CLAUDE_REWIND_PATH } from '../constants.ts'
import { PluginRequestError, pluginWrite } from './plugin-transport.ts'

/** Drop one user message and everything after it: the rows are hidden from
 *  this session's transcript and Claude resumes before that turn. */
export async function rewindSession(sessionId: string, seq: number): Promise<void> {
  try {
    await pluginWrite<unknown>(CLAUDE_REWIND_PATH, 'fast', undefined, { json: { sessionId, seq } })
  } catch (error) {
    if (!(error instanceof PluginRequestError)) throw error
    // The dialog reads this message as a code. A Host still running the
    // previously loaded server bundle has no rewind route at all, and the
    // transport reports that as `route-missing`: a stale process, not a failed
    // rewind.
    throw new Error(error.code ?? error.reason)
  }
}
