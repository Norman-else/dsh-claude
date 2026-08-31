import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_FILE_PATH } from './constants.ts'
import { registerPluginRoute } from './http.ts'
import { RepositoryFileError, type RepositoryStatusService } from './repository-status.ts'

const MAX_PATH_CHARS = 4_096

/** Read-only slice of a working-tree file so the diff panel can expand unmodified lines around hunks. */
export function registerRepositoryFileRoute(ctx: Context, service: Pick<RepositoryStatusService, 'fileLines'>): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_REPOSITORY_FILE_PATH,
    methods: ['GET'],
    // One bounded read of a file already on disk.
    budget: 'git',
    handler: async io => {
      const params = io.url.searchParams
      const cwd = params.get('cwd')
      const path = params.get('path')
      const from = Number(params.get('from'))
      const to = Number(params.get('to'))
      if (cwd === null || cwd.length === 0 || cwd.length > MAX_PATH_CHARS || !isAbsolute(cwd) || cwd.includes('\0')) {
        return { status: 400, value: { error: 'invalid-request', message: 'The cwd query parameter is invalid.' } }
      }
      if (path === null || path.length === 0 || path.length > MAX_PATH_CHARS) {
        return { status: 400, value: { error: 'invalid-request', message: 'The path query parameter is invalid.' } }
      }
      try {
        return { status: 200, value: await service.fileLines(cwd, path, from, to) }
      } catch (error) {
        if (error instanceof RepositoryFileError) {
          return { status: error.code === 'invalid-request' ? 400 : 409, value: { error: error.code, message: error.message } }
        }
        return { status: 500, value: { error: 'repository-file-unavailable', message: 'The file could not be read.' } }
      }
    },
  })
}
