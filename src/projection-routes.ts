import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ServerResponse } from 'node:http'
import { CLAUDE_PROJECTION_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import type { ClaudeSidecarProjection, ClaudeSidecarRepository } from './sidecar.ts'
import type { ClaudeCommandView } from './command-bridge.ts'
import type { RepositoryStatus } from './repository-status.ts'
import type { ReviewComment } from './review-comments.ts'

const MAX_SESSION_ID_CHARS = 1_024
/** Slow-moving metadata refresh and stream heartbeat cadence; deliberately off
 *  the transcript hot path so git/gh latency never delays visible text. */
const META_REFRESH_MS = 5_000

interface ProjectionTarget {
  readonly sessionId: string
  readonly stream: boolean
}

function targetFromUrl(rawUrl: string | undefined): ProjectionTarget | undefined {
  try {
    const pathname = new URL(rawUrl ?? '/', 'http://localhost').pathname
    const prefix = `${CLAUDE_PROJECTION_PATH}/`
    if (!pathname.startsWith(prefix)) return undefined
    let encoded = pathname.slice(prefix.length)
    const stream = encoded.endsWith('/stream')
    if (stream) encoded = encoded.slice(0, -'/stream'.length)
    if (encoded.length === 0 || encoded.includes('/')) return undefined
    const sessionId = decodeURIComponent(encoded)
    if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS) return undefined
    return { sessionId, stream }
  } catch {
    return undefined
  }
}

interface ProjectionMeta {
  readonly owned: boolean
  readonly commands: readonly ClaudeCommandView[]
  readonly repository?: RepositoryStatus
  readonly reviewComments: readonly ReviewComment[]
}

function envelope(projection: ClaudeSidecarProjection, meta: ProjectionMeta): Record<string, unknown> {
  return {
    schemaVersion: projection.schemaVersion,
    revision: projection.revision,
    owned: meta.owned,
    commands: meta.commands,
    activities: projection.activities,
    ...(projection.contextUsage === undefined ? {} : { contextUsage: projection.contextUsage }),
    ...(projection.tasks === undefined ? {} : { tasks: projection.tasks }),
    ...(meta.repository === undefined ? {} : { repository: meta.repository }),
    reviewComments: meta.reviewComments,
    // Ranges only: the chain anchors behind a rewind are Claude transcript
    // identities and stay on this side of the boundary.
    ...(projection.rewind === undefined ? {} : { rewind: { ranges: projection.rewind.ranges } }),
  }
}

/** Register the browser-readable, credential-free sidecar projection endpoint.
 *  `GET <path>/:sessionId` returns one snapshot; `GET <path>/:sessionId/stream`
 *  returns an NDJSON stream: a full snapshot line followed by incremental
 *  transcript/activity deltas and periodic metadata/heartbeat lines. */
export function registerClaudeProjectionRoute(
  ctx: Context,
  sidecar: ClaudeSidecarRepository,
  ownsSession: (sessionId: string) => boolean,
  commandsForSession: (sessionId: string) => readonly ClaudeCommandView[] = () => [],
  repositoryForSession: (sessionId: string) => Promise<RepositoryStatus | undefined> = async () => undefined,
  reviewCommentsForSession: (sessionId: string) => readonly ReviewComment[] = () => [],
): void {
  const info = (message: string): void => {
    ctx.logger?.info?.(message)
  }

  const assembleMeta = async (sessionId: string): Promise<ProjectionMeta> => {
    const owned = ownsSession(sessionId)
    const repository = owned ? await repositoryForSession(sessionId) : undefined
    return {
      owned,
      commands: commandsForSession(sessionId),
      ...(repository === undefined ? {} : { repository }),
      reviewComments: owned ? reviewCommentsForSession(sessionId) : [],
    }
  }

  const streamProjection = async (res: ServerResponse, sessionId: string): Promise<void> => {
    info(`dsh-claude: projection stream opened for ${sessionId.slice(0, 64)}`)
    // Delta-cadence telemetry: reveals upstream text granularity in the log.
    let textDeltas = 0
    let textBytes = 0
    let textSince = Date.now()
    let meta = await assembleMeta(sessionId)
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.flushHeaders?.()
    let closed = false
    const writeLine = (value: unknown): void => {
      if (closed) return
      try {
        res.write(`${JSON.stringify(value)}\n`)
      } catch {
        closed = true
      }
    }
    const writeSnapshot = async (): Promise<void> => {
      const projection = await sidecar.read(sessionId)
      writeLine({ type: 'snapshot', ...envelope(projection, meta) })
    }
    await writeSnapshot()
    const unsubscribe = sidecar.subscribe(sessionId, delta => {
      switch (delta.kind) {
        case 'text':
          textDeltas += 1
          textBytes += (delta.append ?? delta.text ?? '').length
          if (textDeltas % 25 === 0) {
            const elapsed = Date.now() - textSince
            info(`dsh-claude: stream ${sessionId.slice(0, 24)} 25 text deltas ${textBytes}B in ${elapsed}ms`)
            textBytes = 0
            textSince = Date.now()
          }
          writeLine({
            type: 'text',
            turn: delta.turn,
            step: delta.step,
            ordinal: delta.ordinal,
            ...(delta.append === undefined ? {} : { append: delta.append }),
            ...(delta.text === undefined ? {} : { text: delta.text }),
          })
          return
        case 'activity':
          writeLine({ type: 'activity', activity: delta.activity })
          return
        case 'contextUsage':
          writeLine({ type: 'contextUsage', value: delta.value })
          return
        case 'tasks':
          writeLine({ type: 'tasks', value: delta.value })
          return
        case 'sync':
          void writeSnapshot().catch(() => undefined)
      }
    })
    const timer = setInterval(() => {
      void (async () => {
        const next = await assembleMeta(sessionId)
        if (closed) return
        if (JSON.stringify(next) === JSON.stringify(meta)) {
          writeLine({ type: 'ping' })
          return
        }
        meta = next
        writeLine({
          type: 'meta',
          owned: meta.owned,
          commands: meta.commands,
          ...(meta.repository === undefined ? {} : { repository: meta.repository }),
          reviewComments: meta.reviewComments,
        })
      })().catch(() => undefined)
    }, META_REFRESH_MS)
    timer.unref?.()
    await new Promise<void>(resolve => {
      res.on('close', () => {
        closed = true
        clearInterval(timer)
        unsubscribe()
        info(`dsh-claude: projection stream closed for ${sessionId.slice(0, 64)} after ${textDeltas} text deltas`)
        resolve()
      })
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CLAUDE_PROJECTION_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      const target = targetFromUrl(req.url)
      if (target === undefined) return json(res, 400, { error: 'invalid session id' })
      try {
        if (target.stream) return await streamProjection(res, target.sessionId)
        // A steady 2s cadence here means a stale (pre-streaming) client bundle.
        info(`dsh-claude: projection poll for ${target.sessionId.slice(0, 64)}`)
        const projection = await sidecar.read(target.sessionId)
        return json(res, 200, envelope(projection, await assembleMeta(target.sessionId)))
      } catch {
        if (!res.headersSent) return json(res, 500, { error: 'projection unavailable' })
        res.end()
      }
    },
  }), 'dsh-claude: sidecar projection route')
}
