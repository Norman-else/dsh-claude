import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_PERMISSION_MODE_PATH } from '../src/constants.ts'
import { registerClaudePermissionModeRoute } from '../src/permission-mode-routes.ts'
import { ClaudeSidecarRepository } from '../src/sidecar.ts'

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
        expect(route).toMatchObject({ kind: 'exact', path: CLAUDE_PERMISSION_MODE_PATH })
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
    url: CLAUDE_PERMISSION_MODE_PATH,
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

const roots: string[] = []

async function sidecar(): Promise<ClaudeSidecarRepository> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-permission-mode-'))
  roots.push(root)
  return new ClaudeSidecarRepository({ root })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('permission mode route', () => {
  it('records the mode for the session and moves the Host preset with it', async () => {
    const ctx = context()
    const store = await sidecar()
    const applyHostPreset = vi.fn(async () => true)
    registerClaudePermissionModeRoute(ctx, store, { ownsSession: id => id === 'owned', busy: () => false, applyHostPreset })
    const res = response()
    await ctx.handler(request({ sessionId: 'owned', mode: 'dontAsk' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ mode: 'dontAsk', sandbox: 'workspace-write', hostSynced: true })
    expect((await store.read('owned')).permissionMode).toBe('dontAsk')
    expect(applyHostPreset).toHaveBeenCalledWith('owned', 'workspace-write')
  })

  it('keeps the record when the Host declines the preset, and says so', async () => {
    const ctx = context()
    const store = await sidecar()
    registerClaudePermissionModeRoute(ctx, store, {
      ownsSession: () => true,
      busy: () => false,
      applyHostPreset: async () => { throw new Error('no preset service') },
    })
    const res = response()
    await ctx.handler(request({ sessionId: 's', mode: 'bypassPermissions' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ mode: 'bypassPermissions', sandbox: 'danger-full-access', hostSynced: false })
    expect((await store.read('s')).permissionMode).toBe('bypassPermissions')
  })

  it('refuses modes Claude Code does not have, other presets, and running turns', async () => {
    const ctx = context()
    const store = await sidecar()
    const applyHostPreset = vi.fn(async () => true)
    registerClaudePermissionModeRoute(ctx, store, { ownsSession: id => id === 'owned', busy: id => id === 'owned', applyHostPreset })
    const invalid = response()
    await ctx.handler(request({ sessionId: 'owned', mode: 'yolo' }), invalid)
    expect(invalid.statusCode).toBe(400)
    const foreign = response()
    await ctx.handler(request({ sessionId: 'other', mode: 'plan' }), foreign)
    expect(foreign.statusCode).toBe(409)
    expect(JSON.parse(foreign.body)).toEqual({ error: 'session-unavailable' })
    const running = response()
    await ctx.handler(request({ sessionId: 'owned', mode: 'plan' }), running)
    expect(running.statusCode).toBe(409)
    expect(JSON.parse(running.body)).toEqual({ error: 'session-busy' })
    expect(applyHostPreset).not.toHaveBeenCalled()
    expect((await store.read('owned')).permissionMode).toBeUndefined()
  })
})
