import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLIENT_GRACE_MS, ROUTE_BUDGET_MS, clientBudgetMs, type RouteBudget } from '../src/plugin-budget.ts'

const root = join(import.meta.dirname, '..')
const srcDir = join(root, 'src')
/** The one module allowed to register a route. */
const HTTP = 'http.ts'
/**
 * Routes that legitimately outlive a budget, allowlisted by name so a fourth
 * one is a deliberate edit to this line rather than an accident. Each holds a
 * connection for as long as it runs, which is the resource this whole contract
 * exists to ration.
 */
const STREAM_ROUTES = new Set(['projection-routes.ts', 'ask-routes.ts', 'repository-setup-routes.ts'])

async function serverSources(): Promise<{ name: string; code: string }[]> {
  const names = (await readdir(srcDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => entry.name)
  return await Promise.all(names.map(async name => ({
    name,
    code: (await readFile(join(srcDir, name), 'utf8'))
      .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
      .replaceAll(/(^|[^:])\/\/[^\n]*/gu, '$1'),
  })))
}

function offenders(files: { name: string; code: string }[], pattern: RegExp, allow: readonly string[] = []): string[] {
  return files
    .filter(file => !allow.includes(file.name) && pattern.test(file.code))
    .map(file => `src/${file.name}`)
}

/**
 * The seal on the server's route surface.
 *
 * Every route used to own its own lifecycle, and the ordering inside one of
 * them was wrong in a way nobody could see: the projection stream attached its
 * disconnect listener only after awaiting an unbounded repository probe, so a
 * client that gave up during that window left the subscription and its timer
 * running for the life of the process. The host log showed 53 streams opened
 * against 33 closed. No route had a deadline at all.
 *
 * `registerPluginRoute` owns that ordering now, and this test is what keeps it
 * owning it.
 */
describe('route contract', () => {
  it('registers every route through the single wrapper', async () => {
    const files = await serverSources()
    expect(offenders(files, /webServer\s*\.\s*register\s*\(/u, [HTTP])).toEqual([])
    // A second transport would sidestep the deadline and the trust check.
    expect(offenders(files, /webServer\s*\.\s*(?:registerUpgrade|registerFallback)\s*\(/u)).toEqual([])
  })

  it('keeps disconnect teardown in the wrapper, where it happens before the first await', async () => {
    const files = await serverSources()
    expect(offenders(files, /\b(?:req|res)\s*\.\s*on\s*\(\s*['"]close['"]/u, [HTTP])).toEqual([])
  })

  it('holds the streaming allowlist to three routes', async () => {
    const files = await serverSources()
    // http.ts declares the mode; the allowlist is about who USES it.
    const streaming = files
      .filter(file => file.name !== HTTP && /mode:\s*'stream'/u.test(file.code))
      .map(file => file.name)
    expect(new Set(streaming)).toEqual(STREAM_ROUTES)
  })

  it('always leaves the client waiting longer than the route it calls', async () => {
    // The original failure in one assertion: the settings panel waited 20s
    // while the routes it called were allowed 30s and more, so the panel that
    // would have reported the problem was guaranteed to time out first.
    for (const budget of Object.keys(ROUTE_BUDGET_MS) as RouteBudget[]) {
      expect(clientBudgetMs(budget)).toBeGreaterThan(ROUTE_BUDGET_MS[budget])
    }
    expect(CLIENT_GRACE_MS).toBeGreaterThan(0)
  })
})

/** The wrapper's own behaviour, against a real `node:http` server.
 *
 *  The fake requests every route test builds cannot catch this class of bug:
 *  they never emit the lifecycle events a real socket does. */
describe('registerPluginRoute lifecycle', () => {
  it('does not mistake a completed request body for a disconnect', async () => {
    // `IncomingMessage` emits 'close' as soon as the body is fully read, with
    // `complete === true`. Treating that as a disconnect cancelled every route
    // that read its own input, and the client got no status line at all.
    const { createServer } = await import('node:http')
    const { registerPluginRoute } = await import('../src/http.ts')
    let seen: unknown
    const server = createServer()
    const context = {
      effect: (register: () => unknown) => { register() },
      webServer: {
        register: (route: { handler: (req: never, res: never) => Promise<void> }) => {
          server.on('request', route.handler as never)
          return () => {}
        },
      },
      logger: { warn: () => {} },
    }
    registerPluginRoute(context as never, {
      mode: 'unary',
      kind: 'exact',
      path: '/plugins/dsh-claude/test',
      methods: ['POST'],
      budget: 'fast',
      handler: async io => {
        seen = await io.body()
        return { status: 200, value: { echoed: seen } }
      },
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-claude/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ echoed: { hello: 'world' } })
      expect(seen).toEqual({ hello: 'world' })
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  })
})
