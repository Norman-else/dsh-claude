import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLAUDE_GLOBAL_SETTINGS_PATH } from '../src/constants.ts'
import { registerClaudeGlobalSettingsRoute } from '../src/global-settings.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function context(): Context & { handler: Handler } {
  const target = { handler: async () => {} } as { handler: Handler }
  return Object.assign(target, {
    effect: (register: () => unknown) => {
      const route = register() as { handler: Handler }
      target.handler = route.handler
    },
    webServer: {
      register: (route: { kind: string; path: string; handler: Handler }) => {
        expect(route).toMatchObject({ kind: 'exact', path: CLAUDE_GLOBAL_SETTINGS_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(method: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const text = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(text.length === 0 ? [] : [Buffer.from(text)]) as IncomingMessage
  Object.assign(req, {
    method,
    headers: { host: 'localhost:56454', ...(text.length === 0 ? {} : { 'content-length': String(Buffer.byteLength(text)) }), ...headers },
    socket: { remoteAddress: '::1' },
  })
  return req
}

function response(): ServerResponse & { statusCode: number; body: string } {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status; return this },
    end(body: string) { this.body = body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('Claude Code global settings route', () => {
  it('reads and updates a registered field through the generic API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-claude-global-route-'))
    roots.push(root)
    const paths = { settingsFile: join(root, 'settings.json'), outputStylesDir: join(root, 'output-styles') }
    await mkdir(root, { recursive: true })
    await writeFile(paths.settingsFile, JSON.stringify({ preserve: 42 }))
    const ctx = context()
    registerClaudeGlobalSettingsRoute(ctx, { paths })

    const get = response()
    await ctx.handler(request('GET'), get)
    expect(get.statusCode).toBe(200)
    expect(JSON.parse(get.body).settings[0]).toMatchObject({ key: 'outputStyle', value: 'Default' })

    const patch = response()
    await ctx.handler(request('PATCH', { changes: { outputStyle: 'Concise' } }), patch)
    expect(patch.statusCode).toBe(200)
    expect(JSON.parse(patch.body).settings[0]).toMatchObject({ value: 'Concise' })
    expect(JSON.parse(await readFile(paths.settingsFile, 'utf8'))).toEqual({ preserve: 42, outputStyle: 'Concise' })
  })

  it('rejects cross-origin, unknown, and oversized changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-claude-global-route-'))
    roots.push(root)
    const ctx = context()
    registerClaudeGlobalSettingsRoute(ctx, { paths: { settingsFile: join(root, 'settings.json'), outputStylesDir: join(root, 'styles') } })

    const forbidden = response()
    await ctx.handler(request('GET', undefined, { host: 'attacker.test', origin: 'https://attacker.test' }), forbidden)
    expect(forbidden.statusCode).toBe(403)

    const unknown = response()
    await ctx.handler(request('PATCH', { changes: { secret: true } }), unknown)
    expect(unknown.statusCode).toBe(400)

    const oversized = response()
    await ctx.handler(request('PATCH', { changes: { outputStyle: 'Default' } }, { 'content-length': '9000' }), oversized)
    expect(oversized.statusCode).toBe(400)
  })
})
