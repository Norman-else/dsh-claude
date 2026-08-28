import { CLAUDE_EDITOR_OPEN_PATH } from '../constants.ts'
import type { EditorId } from '../editor-open.ts'

/** Launch the session's project in a desktop editor on the host machine. */
export async function openProjectInEditor(sessionId: string, editor: EditorId): Promise<void> {
  const result = await fetch(
    `${CLAUDE_EDITOR_OPEN_PATH}?sessionId=${encodeURIComponent(sessionId)}&editor=${encodeURIComponent(editor)}`,
    { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } },
  )
  if (result.ok) return
  const body = await result.json().catch(() => undefined) as { message?: string } | undefined
  throw new Error(typeof body?.message === 'string' ? body.message : 'The editor could not be launched.')
}
