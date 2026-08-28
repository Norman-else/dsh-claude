import { CLAUDE_REWIND_PATH } from '../constants.ts'
import { PLUGIN_READ_TIMEOUT_MS, pluginRequestSignal } from './plugin-request.ts'

/** Drop one user message and everything after it: the rows are hidden from
 *  this session's transcript and Claude resumes before that turn. */
export async function rewindSession(sessionId: string, seq: number): Promise<void> {
  const result = await fetch(CLAUDE_REWIND_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    signal: pluginRequestSignal(PLUGIN_READ_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId, seq }),
  })
  if (result.ok) return
  // A Host still running the previously loaded server bundle has no rewind
  // route at all; that is a stale process, not a failed rewind.
  if (result.status === 404) throw new Error('route-missing')
  const body = await result.json().catch(() => undefined) as { error?: string } | undefined
  throw new Error(typeof body?.error === 'string' ? body.error : `http-${result.status}`)
}
