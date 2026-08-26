import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ClaudeSidecarRepository } from '../src/sidecar.ts'
import { CLAUDE_PROJECTION_PATH } from '../src/constants.ts'
import { registerClaudeProjectionRoute } from '../src/projection-routes.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function context(): Context & { handler: Handler } {
  const target = { handler: async () => {} } as { handler: Handler }
  return Object.assign(target, {
    effect: (register: () => unknown) => {
      const route = register() as { handler: Handler }
      target.handler = route.handler
    },
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
    socket: { remoteAddress: '::1' },
    ...overrides,
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { statusCode: number; body: string; headers: Record<string, string> } {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(body: string) { this.body = body },
  } as unknown as ServerResponse & { statusCode: number; body: string; headers: Record<string, string> }
}

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

  it('streams a snapshot line, forwards live deltas, and unsubscribes on close', async () => {
    const ctx = context()
    let listener: ((delta: unknown) => void) | undefined
    let unsubscribed = false
    const sidecar = {
      read: async () => ({ schemaVersion: 1 as const, revision: 2, activities: [] }),
      subscribe: (_sessionId: string, callback: (delta: unknown) => void) => {
        listener = callback
        return () => { unsubscribed = true }
      },
    } as unknown as ClaudeSidecarRepository
    registerClaudeProjectionRoute(ctx, sidecar, () => true)
    const closeHandlers: (() => void)[] = []
    const res = {
      statusCode: 0,
      body: '',
      headers: {} as Record<string, string>,
      writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; return this },
      flushHeaders() {},
      write(chunk: string) { this.body += chunk; return true },
      end() {},
      on(event: string, callback: () => void) { if (event === 'close') closeHandlers.push(callback); return this },
    } as unknown as ServerResponse & { statusCode: number; body: string; headers: Record<string, string> }
    const pending = ctx.handler(request(`${CLAUDE_PROJECTION_PATH}/${encodeURIComponent('session/a')}/stream`), res)
    await new Promise(resolve => setImmediate(resolve))
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('ndjson')
    const first = JSON.parse(res.body.split('\n')[0]!)
    expect(first).toMatchObject({ type: 'snapshot', revision: 2, owned: true, reviewComments: [] })
    listener!({ kind: 'text', turn: 1, step: 1, ordinal: 0, append: 'Hi' })
    const lines = res.body.trim().split('\n')
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'text', turn: 1, step: 1, ordinal: 0, append: 'Hi' })
    for (const callback of closeHandlers) callback()
    await pending
    expect(unsubscribed).toBe(true)
  })
})
