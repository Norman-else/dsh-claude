import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_REPOSITORY_STATUS_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import type { RepositoryStatusService } from './repository-status.ts'

const MAX_PATH_CHARS = 4_096

/** Read-only repository status for an arbitrary directory (the overview panel
 *  aggregates every Claude session's checkout through this). */
export function registerRepositoryStatusRoute(ctx: Context, service: RepositoryStatusService): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_REPOSITORY_STATUS_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const cwd = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cwd')
      if (cwd === null || cwd.length === 0 || cwd.length > MAX_PATH_CHARS || !isAbsolute(cwd) || cwd.includes('\0')) {
        return json(res, 400, { error: 'invalid-request', message: 'The cwd query parameter is invalid.' })
      }
      try {
        return json(res, 200, await service.inspect(cwd))
      } catch {
        return json(res, 500, { error: 'repository-status-unavailable', message: 'Repository status is unavailable.' })
      }
    },
  }), 'dsh-claude: repository status route')
}
