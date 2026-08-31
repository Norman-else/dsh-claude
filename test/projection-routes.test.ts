import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ClaudeSidecarRepository } from '../src/sidecar.ts'
import { CLAUDE_PROJECTION_PATH } from '../src/constants.ts'
import { registerClaudeProjectionRoute } from '../src/projection-routes.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function context(): Context & { handler: Handler } {
  const target = { handler: async () => {} } as { handler: Handler }
  return Object.assign(target, {
    effect: (register: () => unknown, _label?: string) => {
      const route = register() as { handler: Handler }
      target.handler = route.handler
    },
    // The projection route is a stream route: registerPluginRoute reports a
    // failed stream through the logger rather than the socket.
    logger: { info: () => {}, warn: () => {} },
    webServer: {
      register: (route: { kind: string; path: string; handler: Handler }) => {
        expect(route).toMatchObject({ kind: 'prefix', path: CLAUDE_PROJECTION_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(url: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost:56454' },
    // registerPluginRoute arms disconnect teardown before its first await, so
    // the fake has to accept listeners on both halves of the exchange.
    on() { return this },
    socket: { remoteAddress: '::1' },
    ...overrides,
  } as unknown as IncomingMessage
}

type FakeResponse = ServerResponse & {
  statusCode: number
  body: string
  headers: Record<string, string>
  flushed: boolean
  /** Fire these to simulate the browser dropping the connection. */
  closeHandlers: (() => void)[]
}

function response(): FakeResponse {
  const closeHandlers: (() => void)[] = []
  return {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    flushed: false,
    headersSent: false,
    writableEnded: false,
    closeHandlers,
    on(event: string, callback: () => void) {
      if (event === 'close') closeHandlers.push(callback)
      return this
    },
    flushHeaders() { this.flushed = true },
    writeHead(status: number, headers: Record<string, string> = {}) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    write(chunk: string) { this.body += chunk; return true },
    end(chunk?: string) { this.writableEnded = true; if (chunk !== undefined) this.body += chunk },
  } as unknown as FakeResponse
}

function lines(res: FakeResponse): Record<string, unknown>[] {
  return res.body.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The multiplexed carrier's URL: one connection, whatever the session count. */
function multi(...sessionIds: readonly string[]): string {
  return `${CLAUDE_PROJECTION_PATH}/multi?sessions=${sessionIds.map(id => encodeURIComponent(id)).join(',')}`
}

const settled = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)) }

afterEach(() => { vi.restoreAllMocks() })

describe('Claude sidecar projection route', () => {
  it('returns only client-safe projection fields', async () => {
    const ctx = context()
    const sidecar = {
      read: async (sessionId: string) => ({
        schemaVersion: 1 as const,
        revision: 3,
        binding: { claudeSessionId: 'private-resume-id', sdkVersion: 'x', cwd: '/tmp' },
        activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'warning' as const }],
        contextUsage: { model: 'default', totalTokens: 1, maxTokens: 10, percentage: 10, categories: [] },
        tasks: { tasks: [] },
      }),
    } as unknown as ClaudeSidecarRepository
    registerClaudeProjectionRoute(ctx, sidecar, sessionId => sessionId === 'session/a', () => [{
      publicName: 'ci-deploy',
      claudeName: 'awesome-skills:ci-deploy',
      description: 'Deploy through CI',
      prefixed: false,
    }], async () => ({
      status: 'ready',
      cwd: '/tmp',
      root: '/tmp',
      branch: 'feature/status',
      detached: false,
      worktree: false,
      dirty: true,
    }))
    const res = response()
    await ctx.handler(request(`${CLAUDE_PROJECTION_PATH}/${encodeURIComponent('session/a')}`), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({
      revision: 3,
      owned: true,
      commands: [{ publicName: 'ci-deploy', claudeName: 'awesome-skills:ci-deploy' }],
      activities: [{ kind: 'warning' }],
      repository: { status: 'ready', branch: 'feature/status', dirty: true },
    })
    expect(body).not.toHaveProperty('binding')
    expect(JSON.stringify(body)).not.toContain('private-resume-id')
  })

  it('returns an empty projection for an unknown session', async () => {
    const ctx = context()
    registerClaudeProjectionRoute(ctx, { read: async () => ({ schemaVersion: 1, revision: 0, activities: [] }) } as ClaudeSidecarRepository, () => false)
    const res = response()
    await ctx.handler(request(`${CLAUDE_PROJECTION_PATH}/unknown`), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ schemaVersion: 1, revision: 0, owned: false, commands: [], activities: [], reviewComments: [] })
  })

  it('rejects malformed, forbidden, and non-GET requests', async () => {
    const ctx = context()
    registerClaudeProjectionRoute(ctx, { read: async () => ({ schemaVersion: 1, revision: 0, activities: [] }) } as ClaudeSidecarRepository, () => false)
    const malformed = response()
    await ctx.handler(request(`${CLAUDE_PROJECTION_PATH}/bad/segment`), malformed)
    expect(malformed.statusCode).toBe(400)
    const forbidden = response()
    await ctx.handler(request(`${CLAUDE_PROJECTION_PATH}/session`, {
      headers: { host: 'attacker.example', origin: 'https://attacker.example' },
    }), forbidden)
    expect(forbidden.statusCode).toBe(403)
    const method = response()
    await ctx.handler(request(`${CLAUDE_PROJECTION_PATH}/session`, { method: 'POST' }), method)
    expect(method.statusCode).toBe(405)
  })

  it('carries every session on one stream, stamping each line with its session', async () => {
    const ctx = context()
    const listeners = new Map<string, (delta: unknown) => void>()
    const unsubscribed: string[] = []
    const sidecar = {
      read: async () => ({ schemaVersion: 1 as const, revision: 2, activities: [] }),
      subscribe: (sessionId: string, callback: (delta: unknown) => void) => {
        listeners.set(sessionId, callback)
        return () => { unsubscribed.push(sessionId) }
      },
    } as unknown as ClaudeSidecarRepository
    registerClaudeProjectionRoute(ctx, sidecar, () => true)
    const res = response()
    const pending = ctx.handler(request(multi('session/a', 'session-b')), res)
    await settled()
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('ndjson')
    expect(lines(res)).toEqual([
      expect.objectContaining({ type: 'snapshot', session: 'session/a', revision: 2, owned: true, reviewComments: [] }),
      expect.objectContaining({ type: 'snapshot', session: 'session-b', revision: 2, owned: true, reviewComments: [] }),
    ])
    listeners.get('session/a')!({ kind: 'text', turn: 1, step: 1, ordinal: 0, append: 'Hi' })
    listeners.get('session-b')!({ kind: 'text', turn: 4, step: 2, ordinal: 7, append: 'There' })
    expect(lines(res).slice(2)).toEqual([
      { type: 'text', session: 'session/a', turn: 1, step: 1, ordinal: 0, append: 'Hi' },
      { type: 'text', session: 'session-b', turn: 4, step: 2, ordinal: 7, append: 'There' },
    ])
    for (const callback of res.closeHandlers) callback()
    await pending
    expect(unsubscribed).toEqual(['session/a', 'session-b'])
  })

  it('paints the carrier before any repository probe, so one wedged session cannot block the rest', async () => {
    const ctx = context()
    const sidecar = {
      read: async () => ({ schemaVersion: 1 as const, revision: 5, activities: [] }),
      subscribe: () => () => undefined,
    } as unknown as ClaudeSidecarRepository
    registerClaudeProjectionRoute(
      ctx,
      sidecar,
      () => true,
      () => [],
      async sessionId => sessionId === 'wedged'
        ? await new Promise(() => undefined)
        : { status: 'ready', cwd: '/tmp', root: '/tmp', branch: 'main', detached: false, worktree: false, dirty: false },
    )
    const res = response()
    const pending = ctx.handler(request(multi('wedged', 'healthy')), res)
    // Synchronously, before a single probe has had the chance to resolve: the
    // headers are out, so the browser already knows the carrier is alive.
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('ndjson')
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.flushed).toBe(true)
    await settled()
    // The wedged session owes its own lane a snapshot and nobody else's.
    expect(lines(res)).toEqual([
      expect.objectContaining({ type: 'snapshot', session: 'healthy', revision: 5 }),
    ])
    for (const callback of res.closeHandlers) callback()
    await pending
  })

  it('tears the carrier down when the client leaves before the first snapshot resolves', async () => {
    const setIntervals = vi.spyOn(globalThis, 'setInterval')
    const clearIntervals = vi.spyOn(globalThis, 'clearInterval')
    const ctx = context()
    let unsubscribed = 0
    const sidecar = {
      // Never resolves: the client gives up while the snapshot is still being
      // assembled, which is the window the 53-open/33-close leak lived in.
      read: async () => await new Promise(() => undefined),
      subscribe: () => () => { unsubscribed += 1 },
    } as unknown as ClaudeSidecarRepository
    registerClaudeProjectionRoute(ctx, sidecar, () => true)
    const res = response()
    const pending = ctx.handler(request(multi('session/a', 'session-b')), res)
    for (const callback of res.closeHandlers) callback()
    await pending
    expect(res.body).toBe('')
    expect(unsubscribed).toBe(2)
    const timer = setIntervals.mock.results.at(-1)?.value
    expect(timer).toBeDefined()
    expect(clearIntervals).toHaveBeenCalledWith(timer)
  })
})
