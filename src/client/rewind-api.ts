import { CLAUDE_REWIND_PATH } from '../constants.ts'
import { PluginRequestError, pluginWrite } from './plugin-transport.ts'

/** Drop one user message and everything after it: the rows are hidden from
 *  this session's transcript and Claude resumes before that turn.
 *
 *  With `restoreFiles`, the checkout is put back to the tree that turn was
 *  admitted against. The answer reports whether that half actually landed:
 *  a turn from before this session captured trees, or a tree git has since
 *  collected, still rewinds the conversation and leaves the files alone. */
export async function rewindSession(
  sessionId: string,
  seq: number,
  restoreFiles = false,
): Promise<{ filesRestored: boolean }> {
  try {
    const answer = await pluginWrite<unknown>(CLAUDE_REWIND_PATH, 'fast', undefined, {
      json: { sessionId, seq, restoreFiles },
    })
    return { filesRestored: (answer as { filesRestored?: unknown } | undefined)?.filesRestored === true }
  } catch (error) {
    if (!(error instanceof PluginRequestError)) throw error
    // The dialog reads this message as a code. A Host still running the
    // previously loaded server bundle has no rewind route at all, and the
    // transport reports that as `route-missing`: a stale process, not a failed
    // rewind.
    throw new Error(error.code ?? error.reason)
  }
}
