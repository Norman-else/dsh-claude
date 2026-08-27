import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_FILE_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import { RepositoryFileError, type RepositoryStatusService } from './repository-status.ts'

const MAX_PATH_CHARS = 4_096

/** Read-only slice of a working-tree file so the diff panel can expand unmodified lines around hunks. */
export function registerRepositoryFileRoute(ctx: Context, service: Pick<RepositoryStatusService, 'fileLines'>): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_REPOSITORY_FILE_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const cwd = params.get('cwd')
      const path = params.get('path')
      const from = Number(params.get('from'))
      const to = Number(params.get('to'))
      if (cwd === null || cwd.length === 0 || cwd.length > MAX_PATH_CHARS || !isAbsolute(cwd) || cwd.includes('\0')) {
        return json(res, 400, { error: 'invalid-request', message: 'The cwd query parameter is invalid.' })
      }
      if (path === null || path.length === 0 || path.length > MAX_PATH_CHARS) {
        return json(res, 400, { error: 'invalid-request', message: 'The path query parameter is invalid.' })
      }
      try {
        return json(res, 200, await service.fileLines(cwd, path, from, to))
      } catch (error) {
        if (error instanceof RepositoryFileError) return json(res, error.code === 'invalid-request' ? 400 : 409, { error: error.code, message: error.message })
        return json(res, 500, { error: 'repository-file-unavailable', message: 'The file could not be read.' })
      }
    },
  }), 'dsh-claude: repository file route')
}
