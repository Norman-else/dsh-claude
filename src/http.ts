import type { IncomingMessage, ServerResponse } from 'node:http'

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
