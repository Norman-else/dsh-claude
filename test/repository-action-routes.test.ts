import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_REPOSITORY_ACTION_PATH } from '../src/constants.ts'
import { registerRepositoryActionRoute } from '../src/repository-action-routes.ts'
import { RepositoryActionError, type RepositoryActionService } from '../src/repository-actions.ts'

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
        expect(route).toMatchObject({ kind: 'prefix', path: CLAUDE_REPOSITORY_ACTION_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(method: string, url: string, body?: unknown, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  // io.body() consumes the request with `for await`, so the body has to be a
  // real stream; the declared content-length is what the wrapper's byte cap
  // reads before it starts reading.
  const stream = Readable.from(text.length === 0 ? [] : [Buffer.from(text)])
  return {
    method,
    url,
    headers: {
      host: 'localhost:56454',
      origin: 'http://localhost:56454',
      ...(text.length === 0 ? {} : { 'content-length': String(Buffer.byteLength(text)) }),
    },
    socket: { remoteAddress: '::1' },
    // registerPluginRoute wires disconnect teardown before its first await.
    // These cases model a caller that stays connected for the whole exchange,
    // so the fake accepts listeners and never fires one.
    on() { return this },
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    ...overrides,
  } as unknown as IncomingMessage
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

function service() {
  return {
    preview: vi.fn(async () => ({
      root: '/repo', branch: 'main', head: 'a', fingerprint: 'fingerprint', files: [], patch: '',
      truncated: false, hasStaged: false, hasUnstaged: false, hasUntracked: false,
    })),
    generateMessage: vi.fn(async () => 'Update files'),
    execute: vi.fn(async () => ({ commit: 'b', pushed: false })),
  }
}

describe('repository action route', () => {
  it('binds preview, generation, and execution to the Host-owned session cwd', async () => {
    const ctx = context()
    const actions = service()
    registerRepositoryActionRoute(ctx, actions as unknown as RepositoryActionService, id => id === 'owned' ? '/canonical/repo' : undefined)

    const preview = response()
    await ctx.handler(request('GET', `${CLAUDE_REPOSITORY_ACTION_PATH}/preview?sessionId=owned`), preview)
    expect(preview.statusCode).toBe(200)
    expect(actions.preview).toHaveBeenCalledWith('/canonical/repo')

    const message = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_ACTION_PATH}/message?sessionId=owned`, { fingerprint: 'fingerprint', cwd: '/attacker' }), message)
    expect(message.statusCode).toBe(200)
    expect(actions.generateMessage).toHaveBeenCalledWith('/canonical/repo', 'fingerprint')

    const execute = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_ACTION_PATH}?sessionId=owned`, {
      action: 'commit', fingerprint: 'fingerprint', message: 'Update files', includeUnstaged: true, cwd: '/attacker',
    }), execute)
    expect(execute.statusCode).toBe(200)
    expect(actions.execute).toHaveBeenCalledWith('/canonical/repo', {
      action: 'commit', fingerprint: 'fingerprint', message: 'Update files', includeUnstaged: true,
    })
  })

  it('rejects cross-origin, unknown-session, malformed, and oversized requests', async () => {
    const ctx = context()
    registerRepositoryActionRoute(ctx, service() as unknown as RepositoryActionService, () => undefined)
    const forbidden = response()
    await ctx.handler(request('GET', `${CLAUDE_REPOSITORY_ACTION_PATH}/preview?sessionId=owned`, undefined, {
      headers: { host: 'localhost:56454', origin: 'https://attacker.example' },
    }), forbidden)
    expect(forbidden.statusCode).toBe(403)

    const unknown = response()
    await ctx.handler(request('GET', `${CLAUDE_REPOSITORY_ACTION_PATH}/preview?sessionId=missing`), unknown)
    expect(unknown.statusCode).toBe(409)
    expect(JSON.parse(unknown.body)).toMatchObject({ error: 'session-unavailable' })

    const malformedCtx = context()
    registerRepositoryActionRoute(malformedCtx, service() as unknown as RepositoryActionService, () => '/repo')
    const malformed = response()
    await malformedCtx.handler(request('POST', `${CLAUDE_REPOSITORY_ACTION_PATH}?sessionId=owned`, '{bad'), malformed)
    expect(malformed.statusCode).toBe(400)

    const oversized = response()
    await malformedCtx.handler(request('POST', `${CLAUDE_REPOSITORY_ACTION_PATH}?sessionId=owned`, 'x'.repeat(17 * 1024)), oversized)
    expect(oversized.statusCode).toBe(409)
    expect(JSON.parse(oversized.body)).toMatchObject({ error: 'body-too-large' })
  })

  it('normalizes service failures without leaking stderr and reports partial success', async () => {
    const ctx = context()
    const actions = service()
    actions.execute.mockRejectedValueOnce(new RepositoryActionError('push-failed', 'Git push failed.', 'commit-oid'))
    registerRepositoryActionRoute(ctx, actions as unknown as RepositoryActionService, () => '/repo')
    const res = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_ACTION_PATH}?sessionId=owned`, {
      action: 'commit-push', fingerprint: 'fingerprint', message: 'Update files', includeUnstaged: false,
    }), res)
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'push-failed', message: 'Git push failed.', commit: 'commit-oid' })
    expect(res.body).not.toContain('stderr')
  })
})

describe('repository merge route validation', () => {
  it('accepts merge-pr with a known method and rejects unknown ones', async () => {
    const ctx = context()
    const actions = service()
    registerRepositoryActionRoute(ctx, actions as unknown as RepositoryActionService, () => '/repo')

    const ok = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_ACTION_PATH}?sessionId=s`, {
      action: 'merge-pr', fingerprint: 'fingerprint', includeUnstaged: false, mergeMethod: 'squash',
    }), ok)
    expect(ok.statusCode).toBe(200)
    expect(actions.execute).toHaveBeenCalledWith('/repo', expect.objectContaining({
      action: 'merge-pr', message: '', mergeMethod: 'squash',
    }))

    const bad = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_ACTION_PATH}?sessionId=s`, {
      action: 'merge-pr', fingerprint: 'fingerprint', includeUnstaged: false, mergeMethod: 'fast-forward',
    }), bad)
    expect(bad.statusCode).toBe(409)
    expect(JSON.parse(bad.body)).toMatchObject({ error: 'invalid-request' })
    expect(actions.execute).toHaveBeenCalledTimes(1)
  })
})
