import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_PROJECTION_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import type { ClaudeSidecarRepository } from './sidecar.ts'
import type { ClaudeCommandView } from './command-bridge.ts'
import type { RepositoryStatus } from './repository-status.ts'
import type { ReviewComment } from './review-comments.ts'

const MAX_SESSION_ID_CHARS = 1_024

function sessionIdFromUrl(rawUrl: string | undefined): string | undefined {
  try {
    const pathname = new URL(rawUrl ?? '/', 'http://localhost').pathname
    const prefix = `${CLAUDE_PROJECTION_PATH}/`
    if (!pathname.startsWith(prefix)) return undefined
    const encoded = pathname.slice(prefix.length)
    if (encoded.length === 0 || encoded.includes('/')) return undefined
    const sessionId = decodeURIComponent(encoded)
    if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS) return undefined
    return sessionId
  } catch {
    return undefined
  }
}

/** Register the browser-readable, credential-free sidecar projection endpoint. */
export function registerClaudeProjectionRoute(
  ctx: Context,
  sidecar: ClaudeSidecarRepository,
  ownsSession: (sessionId: string) => boolean,
  commandsForSession: (sessionId: string) => readonly ClaudeCommandView[] = () => [],
  repositoryForSession: (sessionId: string) => Promise<RepositoryStatus | undefined> = async () => undefined,
  reviewCommentsForSession: (sessionId: string) => readonly ReviewComment[] = () => [],
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CLAUDE_PROJECTION_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      const sessionId = sessionIdFromUrl(req.url)
      if (sessionId === undefined) return json(res, 400, { error: 'invalid session id' })
      try {
        const projection = await sidecar.read(sessionId)
        const owned = ownsSession(sessionId)
        const repository = owned ? await repositoryForSession(sessionId) : undefined
        return json(res, 200, {
          schemaVersion: projection.schemaVersion,
          revision: projection.revision,
          owned,
          commands: commandsForSession(sessionId),
          activities: projection.activities,
          ...(projection.contextUsage === undefined ? {} : { contextUsage: projection.contextUsage }),
          ...(projection.tasks === undefined ? {} : { tasks: projection.tasks }),
          ...(repository === undefined ? {} : { repository }),
          reviewComments: owned ? reviewCommentsForSession(sessionId) : [],
        })
      } catch {
        return json(res, 500, { error: 'projection unavailable' })
      }
    },
  }), 'dsh-claude: sidecar projection route')
}
