import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLAUDE_REVIEW_COMMENT_PATH } from '../src/constants.ts'
import { registerReviewCommentRoute } from '../src/review-comment-routes.ts'
import { ReviewCommentStore } from '../src/review-comments.ts'

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
        expect(route).toMatchObject({ kind: 'prefix', path: CLAUDE_REVIEW_COMMENT_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

/** `io.body()` reads the request with `for await` and refuses a body whose
 *  declared length overruns the route cap, so a fake carrying one has to be
 *  async-iterable and has to declare its own size. */
function request(url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    url,
    headers: {
      host: 'localhost:56454',
      ...(payload === undefined ? {} : { 'content-length': String(payload.byteLength) }),
    },
    // registerPluginRoute attaches its disconnect teardown before the first
    // await, so even a request that never disconnects has to accept listeners.
    on() { return this },
    socket: { remoteAddress: '::1' },
    [Symbol.asyncIterator]: async function* () {
      if (payload !== undefined) yield payload
    },
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { statusCode: number; body: string } {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    on() { return this },
    flushHeaders() {},
    write(chunk: string) { this.body += chunk; return true },
    writeHead(status: number) {
      this.statusCode = status
      this.headersSent = true
      return this
    },
    end(body?: string) { this.writableEnded = true; if (body !== undefined) this.body += body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('Claude review comment routes', () => {
  it('adds, removes, and clears pending comments for owned sessions', async () => {
    const ctx = context()
    const store = new ReviewCommentStore()
    registerReviewCommentRoute(ctx, store, sessionId => sessionId === 'owned')

    const added = response()
    await ctx.handler(request(`${CLAUDE_REVIEW_COMMENT_PATH}?sessionId=owned`, {
      path: 'src/a.ts', line: 12, side: 'new', text: 'Rename this.',
    }), added)
    expect(added.statusCode).toBe(200)
    const comment = (JSON.parse(added.body) as { comment: { id: string } }).comment
    expect(store.list('owned')).toHaveLength(1)

    const removed = response()
    await ctx.handler(request(`${CLAUDE_REVIEW_COMMENT_PATH}/remove?sessionId=owned`, { id: comment.id }), removed)
    expect(JSON.parse(removed.body)).toEqual({ removed: true })
    expect(store.list('owned')).toHaveLength(0)

    store.add('owned', { path: 'src/a.ts', line: 1, side: 'new', text: 'one' })
    store.add('owned', { path: 'src/b.ts', line: 2, side: 'new', text: 'two' })
    const cleared = response()
    await ctx.handler(request(`${CLAUDE_REVIEW_COMMENT_PATH}/clear?sessionId=owned`), cleared)
    expect(cleared.statusCode).toBe(200)
    expect(JSON.parse(cleared.body)).toEqual({ removed: 2 })
    expect(store.list('owned')).toHaveLength(0)
  })

  it('rejects unowned sessions, invalid bodies, and unknown paths', async () => {
    const ctx = context()
    const store = new ReviewCommentStore()
    registerReviewCommentRoute(ctx, store, () => false)
    const denied = response()
    await ctx.handler(request(`${CLAUDE_REVIEW_COMMENT_PATH}/clear?sessionId=other`), denied)
    expect(denied.statusCode).toBe(409)
    expect(JSON.parse(denied.body)).toMatchObject({ error: 'session-unavailable' })

    const owningCtx = context()
    registerReviewCommentRoute(owningCtx, store, () => true)
    const invalid = response()
    await owningCtx.handler(request(`${CLAUDE_REVIEW_COMMENT_PATH}?sessionId=s`, { path: '', line: 1, side: 'new', text: 'x' }), invalid)
    expect(invalid.statusCode).toBe(409)
    const missing = response()
    await owningCtx.handler(request(`${CLAUDE_REVIEW_COMMENT_PATH}/unknown?sessionId=s`), missing)
    expect(missing.statusCode).toBe(404)
  })
})
