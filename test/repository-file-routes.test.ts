import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_REPOSITORY_FILE_PATH } from '../src/constants.ts'
import { registerRepositoryFileRoute } from '../src/repository-file-routes.ts'
import { RepositoryFileError } from '../src/repository-status.ts'

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
        expect(route).toMatchObject({ kind: 'exact', path: CLAUDE_REPOSITORY_FILE_PATH })
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

describe('repository file route', () => {
  it('returns a line slice and maps service validation errors to 400', async () => {
    const ctx = context()
    const fileLines = vi.fn(async (_cwd: string, path: string, from: number, to: number) => {
      if (path.includes('..')) throw new RepositoryFileError('invalid-request', 'escapes')
      return { lines: [`${path}:${from}`, `${path}:${to}`], total: 40 }
    })
    registerRepositoryFileRoute(ctx, { fileLines })

    const ok = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FILE_PATH}?cwd=${encodeURIComponent('/repo')}&path=src%2Fa.ts&from=3&to=4`), ok)
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ lines: ['src/a.ts:3', 'src/a.ts:4'], total: 40 })
    expect(fileLines).toHaveBeenCalledWith('/repo', 'src/a.ts', 3, 4)

    const escaping = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FILE_PATH}?cwd=${encodeURIComponent('/repo')}&path=..%2Fetc%2Fpasswd&from=1&to=2`), escaping)
    expect(escaping.statusCode).toBe(400)

    const relative = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FILE_PATH}?cwd=relative&path=a&from=1&to=2`), relative)
    expect(relative.statusCode).toBe(400)
    expect(fileLines).toHaveBeenCalledTimes(2)
  })
})
