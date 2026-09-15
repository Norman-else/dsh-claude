import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLAUDE_TASK_STOP_PATH } from '../src/constants.ts'
import type { ClaudeTaskInfo } from '../src/events.ts'
import { registerClaudeTaskRoute, type ClaudeTaskAccess } from '../src/task-routes.ts'

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
        expect(route).toMatchObject({ kind: 'exact', path: CLAUDE_TASK_STOP_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(body?: unknown): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    url: CLAUDE_TASK_STOP_PATH,
    headers: {
      host: 'localhost:56454',
      ...(payload === undefined ? {} : { 'content-length': String(payload.byteLength) }),
    },
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

const running: ClaudeTaskInfo = { taskId: 'task-1', description: 'Watch logs', status: 'running', backgrounded: true }

function access(tasks: readonly ClaudeTaskInfo[], stopTask = vi.fn(async () => 'stopped' as const)) {
  return { tasksFor: () => tasks, stopTask } as ClaudeTaskAccess & { stopTask: typeof stopTask }
}

describe('Claude task routes', () => {
  it('stops a running task the session board knows', async () => {
    const ctx = context()
    const api = access([running])
    registerClaudeTaskRoute(ctx, api)
    const res = response()
    await ctx.handler(request({ sessionId: 'dsh-1', taskId: 'task-1' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(api.stopTask).toHaveBeenCalledWith('dsh-1', 'task-1')
  })

  it('refuses a task the board does not hold, and one that already settled', async () => {
    const ctx = context()
    const api = access([{ taskId: 'task-2', description: 'Done', status: 'completed' }])
    registerClaudeTaskRoute(ctx, api)

    const unknown = response()
    await ctx.handler(request({ sessionId: 'dsh-1', taskId: 'task-9' }), unknown)
    expect(unknown.statusCode).toBe(409)
    expect(JSON.parse(unknown.body)).toEqual({ error: 'task-unavailable' })

    // A settled task is the board's answer, not the CLI's: the stop request is
    // never sent for work that has already ended.
    const settled = response()
    await ctx.handler(request({ sessionId: 'dsh-1', taskId: 'task-2' }), settled)
    expect(settled.statusCode).toBe(409)
    expect(JSON.parse(settled.body)).toEqual({ error: 'task-settled' })
    expect(api.stopTask).not.toHaveBeenCalled()
  })

  it('reports a task the process could not reach as a conflict, and rejects malformed requests', async () => {
    const ctx = context()
    const api = access([running], vi.fn(async () => 'unavailable' as const))
    registerClaudeTaskRoute(ctx, api)

    const unreachable = response()
    await ctx.handler(request({ sessionId: 'dsh-1', taskId: 'task-1' }), unreachable)
    expect(unreachable.statusCode).toBe(409)
    expect(JSON.parse(unreachable.body)).toEqual({ error: 'task-unavailable' })

    for (const body of [{ sessionId: 'dsh-1' }, { sessionId: '', taskId: 'task-1' }, { sessionId: 'dsh-1', taskId: 7 }, 'nonsense']) {
      const res = response()
      await ctx.handler(request(body), res)
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid-request' })
    }
  })
})
