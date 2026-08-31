import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_STATUS_PATH } from './constants.ts'
import { registerPluginRoute } from './http.ts'
import type { RepositoryStatusService } from './repository-status.ts'

const MAX_PATH_CHARS = 4_096

/** Read-only repository status for an arbitrary directory (the overview panel
 *  aggregates every Claude session's checkout through this).
 *
 *  The route signal is threaded into the service because this is the one read
 *  the overview polls per distinct checkout every 30 seconds: freeing the
 *  socket at the budget while the Host kept scanning would just grow a queue
 *  of work nobody is waiting for any more. */
export function registerRepositoryStatusRoute(ctx: Context, service: RepositoryStatusService): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_REPOSITORY_STATUS_PATH,
    methods: ['GET'],
    budget: 'git',
    handler: async io => {
      const cwd = io.url.searchParams.get('cwd')
      if (cwd === null || cwd.length === 0 || cwd.length > MAX_PATH_CHARS || !isAbsolute(cwd) || cwd.includes('\0')) {
        return { status: 400, value: { error: 'invalid-request', message: 'The cwd query parameter is invalid.' } }
      }
      try {
        return { status: 200, value: await service.inspect(cwd, io.signal) }
      } catch {
        return { status: 500, value: { error: 'repository-status-unavailable', message: 'Repository status is unavailable.' } }
      }
    },
  })
}
