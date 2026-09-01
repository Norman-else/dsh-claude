import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ServerResponse } from 'node:http'
import { CLAUDE_PROJECTION_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import { MAX_MULTIPLEX_SESSIONS } from './plugin-budget.ts'
import type { ClaudeSidecarProjection, ClaudeSidecarRepository } from './sidecar.ts'
import type { ClaudeCommandView } from './command-bridge.ts'
import type { RepositoryStatus } from './repository-status.ts'
import type { ReviewComment } from './review-comments.ts'

const MAX_SESSION_ID_CHARS = 1_024
/** Slow-moving metadata refresh and stream heartbeat cadence; deliberately off
 *  the transcript hot path so git/gh latency never delays visible text. */
const META_REFRESH_MS = 5_000
/** The multiplexed carrier's path segment. Session ids are `session-<uuid>`,
 *  so this cannot collide with one. */
const MULTI_SEGMENT = 'multi'

type ProjectionTarget =
  | { readonly kind: 'snapshot'; readonly sessionId: string }
  | { readonly kind: 'multi'; readonly sessionIds: readonly string[] }

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SESSION_ID_CHARS
}

function targetFromUrl(url: URL): ProjectionTarget | undefined {
  const prefix = `${CLAUDE_PROJECTION_PATH}/`
  if (!url.pathname.startsWith(prefix)) return undefined
  const encoded = url.pathname.slice(prefix.length)
  if (encoded.length === 0 || encoded.includes('/')) return undefined
  if (encoded === MULTI_SEGMENT) {
    const raw = url.searchParams.get('sessions')
    if (raw === null) return undefined
    const sessionIds = [...new Set(raw.split(',').filter(id => id.length > 0))]
    if (sessionIds.length === 0 || sessionIds.length > MAX_MULTIPLEX_SESSIONS) return undefined
    if (!sessionIds.every(validSessionId)) return undefined
    return { kind: 'multi', sessionIds }
  }
  try {
    const sessionId = decodeURIComponent(encoded)
    return validSessionId(sessionId) ? { kind: 'snapshot', sessionId } : undefined
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
 *
 *  `GET <path>/:sessionId` returns one snapshot. `GET <path>/multi?sessions=a,b`
 *  returns ONE NDJSON stream carrying every listed session, each line stamped
 *  with its `session`.
 *
 *  There is deliberately no per-session stream URL. The browser shares a small
 *  fixed connection budget between this plugin and the Host, and a stream per
 *  session spent it in proportion to how many Claude sessions existed — which
 *  is what left the settings panel unable to get a connection at all. One
 *  carrier is one connection, whatever the session count. */
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

  /** Everything the host already knows, without touching the repository. */
  const localMeta = (sessionId: string): ProjectionMeta => {
    const owned = ownsSession(sessionId)
    return {
      owned,
      commands: commandsForSession(sessionId),
      reviewComments: owned ? reviewCommentsForSession(sessionId) : [],
    }
  }

  const assembleMeta = async (sessionId: string): Promise<ProjectionMeta> => {
    const meta = localMeta(sessionId)
    const repository = meta.owned ? await repositoryForSession(sessionId) : undefined
    return { ...meta, ...(repository === undefined ? {} : { repository }) }
  }

  const streamMulti = async (res: ServerResponse, io: PluginRouteIo, sessionIds: readonly string[]): Promise<void> => {
    info(`dsh-claude: projection stream opened for ${sessionIds.length} session(s)`)
    let textDeltas = 0
    let textBytes = 0
    let textSince = Date.now()
    // Headers first, before any await. One session whose repository probe is
    // slow must not delay every other session's first paint — and until the
    // headers are out the client cannot even tell the carrier is alive.
    // `no-transform` keeps a compressing proxy from buffering the sole carrier.
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
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
    const metas = new Map<string, ProjectionMeta>()
    const writeMeta = (sessionId: string, meta: ProjectionMeta): void => {
      metas.set(sessionId, meta)
      writeLine({
        type: 'meta',
        session: sessionId,
        owned: meta.owned,
        commands: meta.commands,
        ...(meta.repository === undefined ? {} : { repository: meta.repository }),
        reviewComments: meta.reviewComments,
      })
    }
    const writeSnapshot = async (sessionId: string): Promise<void> => {
      const projection = await sidecar.read(sessionId)
      // The repository probe runs a chain of git commands and a `gh pr view`
      // over the network -- seconds, where the transcript is already in
      // memory. It rides a later meta line so the prose paints first.
      const meta = metas.get(sessionId) ?? localMeta(sessionId)
      metas.set(sessionId, meta)
      // Where the notification stream stands as of this read, so the first
      // delta after this line has a number to be contiguous with.
      writeLine({ type: 'snapshot', session: sessionId, seq: sidecar.sequence(sessionId), ...envelope(projection, meta) })
      const probed = await assembleMeta(sessionId)
      if (closed || JSON.stringify(probed) === JSON.stringify(metas.get(sessionId))) return
      writeMeta(sessionId, probed)
    }
    // Subscribe every lane synchronously, before the first await: a delta that
    // lands while the snapshots are still assembling belongs to this carrier.
    const unsubscribes = sessionIds.map(sessionId => sidecar.subscribe(sessionId, delta => {
      switch (delta.kind) {
        case 'text':
          textDeltas += 1
          textBytes += (delta.append ?? delta.text ?? '').length
          if (textDeltas % 25 === 0) {
            const elapsed = Date.now() - textSince
            info(`dsh-claude: stream 25 text deltas ${textBytes}B in ${elapsed}ms`)
            textBytes = 0
            textSince = Date.now()
          }
          writeLine({
            type: 'text',
            session: sessionId,
            turn: delta.turn,
            step: delta.step,
            ordinal: delta.ordinal,
            ...(delta.append === undefined ? {} : { append: delta.append }),
            ...(delta.text === undefined ? {} : { text: delta.text }),
            ...(delta.renderer === undefined ? {} : { renderer: delta.renderer }),
            seq: delta.seq,
          })
          return
        case 'activity':
          writeLine({ type: 'activity', session: sessionId, activity: delta.activity, seq: delta.seq })
          return
        case 'contextUsage':
          writeLine({ type: 'contextUsage', session: sessionId, value: delta.value, seq: delta.seq })
          return
        case 'tasks':
          writeLine({ type: 'tasks', session: sessionId, value: delta.value, seq: delta.seq })
          return
        case 'checkpoint':
          writeLine({ type: 'checkpoint', session: sessionId, seq: delta.seq })
          return
        case 'sync':
          void writeSnapshot(sessionId).catch(() => undefined)
      }
    }))
    // Per-session, in parallel: a wedged repository probe costs its own lane
    // its first paint, not everyone else's.
    for (const sessionId of sessionIds) {
      void writeSnapshot(sessionId).catch(() => undefined)
    }
    const timer = setInterval(() => {
      void (async () => {
        for (const sessionId of sessionIds) {
          if (closed) return
          const next = await assembleMeta(sessionId)
          if (closed) return
          if (JSON.stringify(next) === JSON.stringify(metas.get(sessionId))) continue
          writeMeta(sessionId, next)
        }
        writeLine({ type: 'ping' })
      })().catch(() => undefined)
    }, META_REFRESH_MS)
    timer.unref?.()
    // Teardown rides the wrapper's signal, which is armed before any await —
    // the previous hand-written `res.on('close')` was attached only after the
    // first metadata probe resolved, so a client that gave up during that
    // window left the interval and every subscription running for good.
    await new Promise<void>(resolve => {
      const finish = (): void => {
        if (closed) return
        closed = true
        clearInterval(timer)
        for (const unsubscribe of unsubscribes) unsubscribe()
        info(`dsh-claude: projection stream closed after ${textDeltas} text deltas`)
        resolve()
      }
      if (io.signal.aborted) finish()
      else io.signal.addEventListener('abort', finish, { once: true })
    })
  }

  registerPluginRoute(ctx, {
    mode: 'stream',
    kind: 'prefix',
    path: CLAUDE_PROJECTION_PATH,
    methods: ['GET'],
    // One carrier. A reconnect supersedes the old one rather than stacking.
    maxConcurrent: 1,
    streamKey: () => MULTI_SEGMENT,
    handler: async (res, io) => {
      const target = targetFromUrl(io.url)
      if (target === undefined) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.write(JSON.stringify({ error: 'invalid session id' }))
        return
      }
      if (target.kind === 'multi') return await streamMulti(res, io, target.sessionIds)
      // A steady 2s cadence here means a stale (pre-streaming) client bundle.
      info(`dsh-claude: projection poll for ${target.sessionId.slice(0, 64)}`)
      try {
        const projection = await sidecar.read(target.sessionId)
        const body = envelope(projection, await assembleMeta(target.sessionId))
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.write(JSON.stringify(body))
      } catch {
        if (res.headersSent) return
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.write(JSON.stringify({ error: 'projection unavailable' }))
      }
    },
  })
}
