import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRouteKind } from '@deepseek-ai/dsh-host-webserver'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { ROUTE_BUDGET_MS, type RouteBudget } from './plugin-budget.ts'

/** Accept only loopback, same-origin browser requests to plugin-private routes. */
export function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const authority = /^(?:127\.0\.0\.1|\[?::1\]?|localhost)(?::\d+)?$/i
  if (!authority.test(host)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const originUrl = new URL(origin)
    return originUrl.host === host && authority.test(originUrl.host)
  } catch {
    return false
  }
}

/** Send a non-cacheable JSON response with MIME sniffing disabled. */
export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

const ROUTE_TIMEOUT_CODE = 'DSH_CLAUDE_ROUTE'
const DEFAULT_BODY_BYTES = 1024 * 1024

export type PluginMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** What a route handler is given. Deliberately not the `ServerResponse`: a
 *  unary handler that cannot reach the socket cannot hold it open. */
export interface PluginRouteIo {
  /** Aborts on client disconnect OR when the route's budget elapses. */
  readonly signal: AbortSignal
  readonly method: PluginMethod
  readonly url: URL
  /** Read the request body once, byte-capped, as JSON. */
  body<T = Record<string, unknown>>(maxBytes?: number): Promise<T>
}

export interface PluginUnaryRoute {
  mode: 'unary'
  kind: WebRouteKind
  path: string
  methods: readonly PluginMethod[]
  budget: RouteBudget
  /** No `ServerResponse` in scope, by construction. */
  handler: (io: PluginRouteIo) => Promise<{ status: number; value: unknown }>
}

export interface PluginStreamRoute {
  mode: 'stream'
  kind: WebRouteKind
  path: string
  methods: readonly PluginMethod[]
  /** Hard ceiling on live responses for this path; the oldest is evicted. */
  maxConcurrent: number
  /** Dedupe identity; a second open with the same key supersedes the first. */
  streamKey: (url: URL) => string
  handler: (res: ServerResponse, io: PluginRouteIo) => Promise<void>
}

export type PluginRoute = PluginUnaryRoute | PluginStreamRoute

/** Bounds live streaming responses per path, so a teardown bug cannot become a
 *  permanent connection leak. Registration is per path, not global, because a
 *  wedged projection stream must not evict an in-flight repository setup. */
class StreamRegistry {
  readonly #open = new Map<string, Map<string, () => void>>()

  admit(path: string, key: string, max: number, close: () => void): () => void {
    let live = this.#open.get(path)
    if (live === undefined) {
      live = new Map()
      this.#open.set(path, live)
    }
    // A reopen under the same identity is the client reconnecting; the older
    // response is the stale one, so it goes rather than the new arrival.
    live.get(key)?.()
    live.set(key, close)
    while (live.size > max) {
      const oldest = live.keys().next()
      if (oldest.done === true) break
      const evict = live.get(oldest.value)
      live.delete(oldest.value)
      evict?.()
    }
    return () => {
      const current = this.#open.get(path)
      if (current?.get(key) === close) current.delete(key)
    }
  }
}

const streams = new StreamRegistry()

function isPluginMethod(value: string | undefined): value is PluginMethod {
  return value === 'GET' || value === 'POST' || value === 'PATCH' || value === 'DELETE'
}

/** Distinguishable so the wrapper can answer 413 rather than folding an
 *  oversized body into whatever generic failure the handler reports. */
export class PluginBodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large')
    this.name = 'PluginBodyTooLargeError'
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) throw new PluginBodyTooLargeError()
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += data.byteLength
    if (bytes > maxBytes) throw new PluginBodyTooLargeError()
    chunks.push(data)
  }
  if (bytes === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function rejectOn(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
  })
}

/**
 * Register one plugin route.
 *
 * This is the only place in the package that calls `ctx.webServer.register`,
 * and the ordering inside it is the fix rather than an implementation detail:
 * the disconnect listeners are attached before the first `await`, so a client
 * that goes away while the handler is still assembling its first response
 * still tears the route's work down. The previous per-route code attached
 * `res.on('close')` after awaiting an unbounded repository probe, which is how
 * the projection stream reached 53 opens against 33 closes.
 */
export function registerPluginRoute(ctx: Context, route: PluginRoute): void {
  const label = `dsh-claude: ${route.path}`
  ctx.effect(() => ctx.webServer.register({
    kind: route.kind,
    path: route.path,
    handler: async (req, res) => {
      const method = req.method
      if (!isPluginMethod(method) || !route.methods.includes(method)) {
        return json(res, 405, { error: 'method not allowed' })
      }
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      // Before any await: a disconnect during setup must still cancel.
      const aborted = new AbortController()
      const abort = (): void => { aborted.abort() }
      // `req` emits 'close' when the request is COMPLETE, not only when the
      // client vanishes — so reading a body fires it, and an unguarded abort
      // here cancels every POST route the instant it parses its own input.
      // `complete` is what tells the two apart.
      req.on('close', () => { if (!req.complete) abort() })
      res.on('close', abort)
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (route.mode === 'stream') {
        const release = streams.admit(route.path, route.streamKey(url), route.maxConcurrent, abort)
        const io: PluginRouteIo = {
          signal: aborted.signal,
          method,
          url,
          body: async <T,>(maxBytes = DEFAULT_BODY_BYTES) => await readBody(req, maxBytes) as T,
        }
        try {
          await route.handler(res, io)
        } catch (error) {
          if (!res.headersSent) json(res, 500, { error: 'stream-failed' })
          ctx.logger.warn(`dsh-claude: ${route.path} stream failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          release()
          res.end()
        }
        return
      }
      const budgetMs = ROUTE_BUDGET_MS[route.budget]
      const bounded = deadline(aborted.signal, budgetMs, ROUTE_TIMEOUT_CODE)
      const io: PluginRouteIo = {
        signal: bounded.signal,
        method,
        url,
        body: async <T,>(maxBytes = DEFAULT_BODY_BYTES) => await readBody(req, maxBytes) as T,
      }
      try {
        const result = await Promise.race([route.handler(io), rejectOn(bounded.signal)])
        if (!res.writableEnded) json(res, result.status, result.value)
      } catch (error) {
        if (res.writableEnded || res.headersSent) return
        if (bounded.signal.aborted && !aborted.signal.aborted) {
          return json(res, 504, { error: 'deadline', budget: route.budget, ms: budgetMs })
        }
        if (aborted.signal.aborted) return
        if (error instanceof PluginBodyTooLargeError) {
          return json(res, 413, { error: 'body-too-large', message: 'The request body is too large.' })
        }
        json(res, 400, { error: error instanceof Error ? error.message : 'request failed' })
      } finally {
        bounded[Symbol.dispose]()
      }
    },
  }), label)
}

/**
 * Memoise an executable lookup with a deadline, dropping the cache when it
 * fails.
 *
 * A route budget frees the socket but does nothing about a cached promise that
 * never settles: one hung PATH probe otherwise poisons every later request for
 * the life of the process, and the route deadline just turns that into a
 * steady stream of 504s. Caching only the resolved value keeps the retry.
 */
export function memoizeExecutable(
  resolve: (signal: AbortSignal) => Promise<string>,
  timeoutMs: number,
): () => Promise<string> {
  let pending: Promise<string> | undefined
  return () => {
    if (pending !== undefined) return pending
    const bounded = deadline(undefined, timeoutMs, ROUTE_TIMEOUT_CODE)
    const attempt = resolve(bounded.signal)
      .finally(() => { bounded[Symbol.dispose]() })
      .catch((error: unknown) => {
        pending = undefined
        throw error
      })
    pending = attempt
    return attempt
  }
}
