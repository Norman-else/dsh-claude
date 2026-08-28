import { CLAUDE_REWIND_PATH } from '../constants.ts'

/** Drop one user message and everything after it: the rows are hidden from
 *  this session's transcript and Claude resumes before that turn. */
export async function rewindSession(sessionId: string, seq: number): Promise<void> {
  const result = await fetch(CLAUDE_REWIND_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId, seq }),
  })
  if (result.ok) return
  const body = await result.json().catch(() => undefined) as { error?: string } | undefined
  throw new Error(typeof body?.error === 'string' ? body.error : 'rewind-unavailable')
}
