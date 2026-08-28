import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_EDITOR_OPEN_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import { EDITOR_IDS, EditorOpenError, type EditorId, type EditorOpenService } from './editor-open.ts'

const MAX_SESSION_ID_CHARS = 1_024

/** Open the session's working directory in a desktop editor. Query-only: the
 *  request carries two enum-ish values, so there is no body to parse. */
export function registerEditorOpenRoute(
  ctx: Context,
  service: Pick<EditorOpenService, 'open'>,
  cwdForSession: (sessionId: string) => string | undefined,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_EDITOR_OPEN_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const id = params.get('sessionId')
      const editor = params.get('editor')
      if (id === null || id.length === 0 || id.length > MAX_SESSION_ID_CHARS) {
        return json(res, 400, { error: 'invalid-session', message: 'The session is invalid.' })
      }
      if (editor === null || !EDITOR_IDS.has(editor)) {
        return json(res, 400, { error: 'invalid-editor', message: 'The editor is invalid.' })
      }
      const cwd = cwdForSession(id)
      if (cwd === undefined) return json(res, 409, { error: 'session-unavailable', message: 'The Claude session is unavailable.' })
      try {
        await service.open(cwd, editor as EditorId)
        return json(res, 200, { opened: true })
      } catch (error) {
        if (error instanceof EditorOpenError) return json(res, 409, { error: error.code, message: error.message })
        return json(res, 500, { error: 'editor-open-unavailable', message: 'The editor could not be launched.' })
      }
    },
  }), 'dsh-claude: editor open route')
}
