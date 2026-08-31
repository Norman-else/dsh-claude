import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const clientDir = join(root, 'src', 'client')
/** The one module allowed to touch the network. */
const TRANSPORT = 'plugin-transport.ts'

async function clientSources(): Promise<{ name: string; code: string }[]> {
  const names = (await readdir(clientDir)).filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
  return await Promise.all(names.map(async name => ({
    name,
    // Comments are stripped first: this file's own prose, and phrases like
    // "git fetch" in explanatory comments elsewhere, are not call sites.
    code: (await readFile(join(clientDir, name), 'utf8'))
      .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
      .replaceAll(/(^|[^:])\/\/[^\n]*/gu, '$1'),
  })))
}

function offenders(files: { name: string; code: string }[], pattern: RegExp, allow: readonly string[] = []): string[] {
  return files
    .filter(file => !allow.includes(file.name) && pattern.test(file.code))
    .map(file => `src/client/${file.name}`)
}

/**
 * The seal on the Client's network surface.
 *
 * The plugin has exhausted the browser's per-origin connection budget twice,
 * and both times the code that did it looked completely ordinary: a `fetch`
 * whose deadline was silently overwritten by a later spread, a stream opened
 * once per session, a fresh `_TIMEOUT_MS` constant longer than the wait of the
 * panel that would have diagnosed it. A previous fix added a shared helper and
 * a comment asking contributors to use it; call sites went around it anyway.
 *
 * So this is the gate rather than the convention. It is a source scan, not a
 * proof — someone determined can still write `globalThis['fet' + 'ch']` — but
 * it stops the failure that actually keeps happening, which is idiomatic code
 * written by someone who never heard of this problem.
 */
describe('client network surface', () => {
  it('routes every request through the single transport module', async () => {
    const files = await clientSources()
    // The bare IDENTIFIER, not `fetch(`. This repo's own house idiom was
    // `fetchProjection: typeof fetch = fetch` — a dependency-injected default
    // that a call-shaped regex sails straight past.
    expect(offenders(files, /\bfetch\b/u, [TRANSPORT])).toEqual([])
  })

  it('opens no second transport that would bypass the connection budget', async () => {
    const files = await clientSources()
    expect(offenders(files, /\b(?:XMLHttpRequest|EventSource|WebSocket|sendBeacon)\b/u)).toEqual([])
  })

  it('lets no call site carry its own signal, which is what discarded the deadlines', async () => {
    const files = await clientSources()
    // `signal: pluginRequestSignal(...)` followed by `...(signal === undefined
    // ? {} : { signal })` is the exact shape that disarmed four call sites:
    // `exactOptionalPropertyTypes` forbids `signal: undefined`, so the spread
    // is what people reach for, and it silently wins. The transport takes
    // `cancel` positionally so there is no property left to overwrite.
    expect(offenders(files, /(?:^|[{,(\s])signal\s*:/mu, [TRANSPORT])).toEqual([])
  })

  it('lets no call site invent its own deadline', async () => {
    const files = await clientSources()
    expect(offenders(files, /AbortSignal\s*\.\s*timeout\s*\(/u, [TRANSPORT])).toEqual([])
    // A free-floating constant is how the client's wait drifted longer than
    // the server budget it was waiting on.
    expect(offenders(files, /_TIMEOUT_MS\s*=\s*\d/u)).toEqual([])
  })

  it('has no deleted request helper left to import', async () => {
    const names = await readdir(clientDir)
    expect(names).not.toContain('plugin-request.ts')
    const files = await clientSources()
    expect(offenders(files, /plugin-request/u)).toEqual([])
  })
})
