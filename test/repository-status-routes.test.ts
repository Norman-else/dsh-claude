import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_REPOSITORY_STATUS_PATH } from '../src/constants.ts'
import { registerRepositoryStatusRoute } from '../src/repository-status-routes.ts'
import type { RepositoryStatusService } from '../src/repository-status.ts'

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
        expect(route).toMatchObject({ kind: 'exact', path: CLAUDE_REPOSITORY_STATUS_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(url: string): IncomingMessage {
  const stream = Readable.from([])
  Object.assign(stream, {
    method: 'GET',
    url,
    headers: { host: 'localhost:56454', origin: 'http://localhost:56454' },
    on() { return this },
    socket: { remoteAddress: '::1' },
  })
  return stream as IncomingMessage
}

function response(): ServerResponse & { statusCode: number; body: string } {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    // registerPluginRoute wires disconnect teardown before its first await, so
    // a fake response has to accept listeners even when a test never fires one.
    on() { return this },
    flushHeaders() {},
    write(chunk: string) { this.body += chunk; return true },
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this },
    end(body?: string) { this.writableEnded = true; if (body !== undefined) this.body += body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('repository status route', () => {
  it('inspects absolute directories and rejects relative ones', async () => {
    const ctx = context()
    // `inspect` takes the route's signal now, so the scan stops with the request.
    const service = { inspect: vi.fn(async (cwd: string, _signal?: AbortSignal) => ({ status: 'ready', cwd })) }
    registerRepositoryStatusRoute(ctx, service as unknown as RepositoryStatusService)

    const ok = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_STATUS_PATH}?cwd=${encodeURIComponent('/repo')}`), ok)
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ status: 'ready', cwd: '/repo' })
    expect(service.inspect).toHaveBeenCalledWith('/repo', expect.any(AbortSignal))

    const relative = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_STATUS_PATH}?cwd=relative`), relative)
    expect(relative.statusCode).toBe(400)
    expect(service.inspect).toHaveBeenCalledTimes(1)
  })
})
