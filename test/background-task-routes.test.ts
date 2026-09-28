import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_BACKGROUND_TASK_PATH } from '../src/constants.ts'
import { registerClaudeBackgroundTaskRoute, type ClaudeBackgroundOutcome } from '../src/background-task-routes.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function context(): Context & { handler: Handler } {
  const target = { handler: async () => {} } as { handler: Handler }
  return Object.assign(target, {
    logger: { warn: vi.fn() },
    effect: (register: () => unknown) => {
      const route = register() as { handler: Handler }
      target.handler = route.handler
    },
    webServer: {
      register: (route: { kind: string; path: string; handler: Handler }) => {
        expect(route).toMatchObject({ kind: 'exact', path: CLAUDE_BACKGROUND_TASK_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(body: unknown): IncomingMessage {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const stream = Readable.from([Buffer.from(text)])
  return {
    method: 'POST',
    url: CLAUDE_BACKGROUND_TASK_PATH,
    headers: { host: 'localhost:56454', origin: 'http://localhost:56454', 'content-length': String(Buffer.byteLength(text)) },
    socket: { remoteAddress: '::1' },
    on() { return this },
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { statusCode: number; body: string } {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    on() { return this },
    once() { return this },
    off() { return this },
    setHeader() { return this },
    flushHeaders() {},
    write(chunk: string) { this.body += chunk; return true },
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this },
    end(body?: string) { this.writableEnded = true; if (body !== undefined) this.body += body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

async function post(handler: Handler, body: unknown) {
  const res = response()
  await handler(request(body), res)
  return { status: res.statusCode, body: res.body.length === 0 ? undefined : JSON.parse(res.body) as unknown }
}

describe('background task route', () => {
  it('moves the named call and reports the refusals as conflicts', async () => {
    const outcomes: ClaudeBackgroundOutcome[] = ['moved', 'not-running', 'unavailable']
    const background = vi.fn(async () => outcomes.shift() ?? 'unavailable')
    const ctx = context()
    registerClaudeBackgroundTaskRoute(ctx, { background })

    expect(await post(ctx.handler, { sessionId: 'dsh-1', toolUseId: 'call-1' })).toEqual({ status: 200, body: { outcome: 'moved' } })
    expect(background).toHaveBeenCalledWith('dsh-1', 'call-1')
    expect(await post(ctx.handler, { sessionId: 'dsh-1', toolUseId: 'call-1' })).toEqual({ status: 409, body: { error: 'not-running' } })
    expect(await post(ctx.handler, { sessionId: 'dsh-1', toolUseId: 'call-1' })).toEqual({ status: 409, body: { error: 'unavailable' } })
  })

  it('rejects a body without both ids', async () => {
    const background = vi.fn(async (): Promise<ClaudeBackgroundOutcome> => 'moved')
    const ctx = context()
    registerClaudeBackgroundTaskRoute(ctx, { background })
    expect((await post(ctx.handler, { sessionId: 'dsh-1' })).status).toBe(400)
    expect((await post(ctx.handler, 'not json')).status).toBe(400)
    expect(background).not.toHaveBeenCalled()
  })
})
