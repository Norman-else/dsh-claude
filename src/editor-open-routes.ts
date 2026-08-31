import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_EDITOR_OPEN_PATH } from './constants.ts'
import { registerPluginRoute } from './http.ts'
import { EDITOR_IDS, EditorOpenError, type EditorId, type EditorOpenService } from './editor-open.ts'

const MAX_SESSION_ID_CHARS = 1_024

/** Open the session's working directory in a desktop editor. Query-only: the
 *  request carries two enum-ish values, so there is no body to parse. */
export function registerEditorOpenRoute(
  ctx: Context,
  service: Pick<EditorOpenService, 'open'>,
  cwdForSession: (sessionId: string) => string | undefined,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_EDITOR_OPEN_PATH,
    methods: ['POST'],
    budget: 'fast',
    handler: async io => {
      const params = io.url.searchParams
      const id = params.get('sessionId')
      const editor = params.get('editor')
      if (id === null || id.length === 0 || id.length > MAX_SESSION_ID_CHARS) {
        return { status: 400, value: { error: 'invalid-session', message: 'The session is invalid.' } }
      }
      if (editor === null || !EDITOR_IDS.has(editor)) {
        return { status: 400, value: { error: 'invalid-editor', message: 'The editor is invalid.' } }
      }
      const cwd = cwdForSession(id)
      if (cwd === undefined) return { status: 409, value: { error: 'session-unavailable', message: 'The Claude session is unavailable.' } }
      try {
        await service.open(cwd, editor as EditorId)
        return { status: 200, value: { opened: true } }
      } catch (error) {
        if (error instanceof EditorOpenError) return { status: 409, value: { error: error.code, message: error.message } }
        return { status: 500, value: { error: 'editor-open-unavailable', message: 'The editor could not be launched.' } }
      }
    },
  })
}
