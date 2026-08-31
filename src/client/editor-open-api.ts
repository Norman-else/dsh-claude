import { CLAUDE_EDITOR_OPEN_PATH } from '../constants.ts'
import type { EditorId } from '../editor-open.ts'
import { pluginWrite } from './plugin-transport.ts'

/** Launch the session's project in a desktop editor on the host machine. */
export async function openProjectInEditor(sessionId: string, editor: EditorId): Promise<void> {
  await pluginWrite<unknown>(CLAUDE_EDITOR_OPEN_PATH, 'fast', undefined, { query: { sessionId, editor } })
}
