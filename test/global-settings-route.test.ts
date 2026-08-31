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
  // io.body() consumes the request with `for await`, so the body has to be a
  // real stream; the declared content-length is what the wrapper's byte cap
  // reads before it starts reading.
  const stream = Readable.from(text.length === 0 ? [] : [Buffer.from(text)])
  return {
    method,
    headers: {
      host: 'localhost:56454',
      ...(text.length === 0 ? {} : { 'content-length': String(Buffer.byteLength(text)) }),
      ...headers,
    },
    socket: { remoteAddress: '::1' },
    // registerPluginRoute wires disconnect teardown before its first await.
    // These cases model a caller that stays connected for the whole exchange,
    // so the fake accepts listeners and never fires one.
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
    // registerPluginRoute wires disconnect teardown before its first await, so
    // a fake response has to accept listeners even when a test never fires one.
    on() { return this },
    flushHeaders() {},
    write(chunk: string) { this.body += chunk; return true },
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this },
    end(body?: string) { this.writableEnded = true; if (body !== undefined) this.body += body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('Claude Code global settings route', () => {
  it('reads and updates a registered field through the generic API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-claude-global-route-'))
    roots.push(root)
    const paths = {
      settingsFile: join(root, 'settings.json'),
      outputStylesDir: join(root, 'output-styles'),
      pluginSettingsFile: join(root, 'plugin-settings.json'),
    }
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

    const prefix = response()
    await ctx.handler(request('PATCH', { changes: { worktreeBranchPrefix: 'team' } }), prefix)
    expect(prefix.statusCode).toBe(200)
    expect(JSON.parse(await readFile(paths.pluginSettingsFile, 'utf8'))).toEqual({ worktreeBranchPrefix: 'team' })
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
    expect(JSON.parse(unknown.body).error).toBe('Unsupported global setting: secret')

    // An otherwise valid change is still refused on its declared size alone,
    // so the cap is enforced before a single byte of body is read.
    const oversized = response()
    await ctx.handler(request('PATCH', { changes: { outputStyle: 'Default' } }, { 'content-length': '9000' }), oversized)
    expect(oversized.statusCode).toBe(400)
    expect(JSON.parse(oversized.body).error).toBe('Request body is too large')
  })
})

describe('Claude Code global settings route side effects', () => {
  it('notifies onUpdated only after a successful PATCH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-claude-global-route-'))
    roots.push(root)
    const paths = {
      settingsFile: join(root, 'settings.json'),
      outputStylesDir: join(root, 'output-styles'),
      pluginSettingsFile: join(root, 'plugin-settings.json'),
    }
    let notified = 0
    const ctx = context()
    registerClaudeGlobalSettingsRoute(ctx, { paths, onUpdated: () => { notified += 1 } })

    const get = response()
    await ctx.handler(request('GET'), get)
    expect(get.statusCode).toBe(200)
    expect(notified).toBe(0)

    const patch = response()
    await ctx.handler(request('PATCH', { changes: { maxProcesses: '6' } }), patch)
    expect(patch.statusCode).toBe(200)
    expect(JSON.parse(patch.body).settings.find((setting: { key: string }) => setting.key === 'maxProcesses')).toMatchObject({ value: '6' })
    expect(notified).toBe(1)

    const invalid = response()
    await ctx.handler(request('PATCH', { changes: { maxProcesses: '99' } }), invalid)
    expect(invalid.statusCode).toBe(400)
    expect(notified).toBe(1)
  })
})
