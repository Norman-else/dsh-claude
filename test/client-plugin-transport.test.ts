import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PluginRequestError,
  __resetPluginTransport,
  __setPluginFetch,
  pluginRead,
  pluginWrite,
} from '../src/client/plugin-transport.ts'
import { ClaudeProjectionStore } from '../src/client/projection.ts'
import { PLUGIN_GLOBAL_PERMITS, QUEUE_WAIT_BUDGET_MS, clientBudgetMs } from '../src/plugin-budget.ts'

afterEach(() => {
  __resetPluginTransport()
  vi.useRealTimers()
})

/** A fetch that never answers, so a permit taken is a permit held. It still
 *  honours the signal, because rejecting on abort is what a real one does and
 *  the deadline is the thing under test. */
function neverAnswers(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0
  const impl = ((_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
    calls += 1
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === undefined) return
      signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls: () => calls }
}

function answers(body: unknown): { fetch: typeof fetch; calls: () => number } {
  let calls = 0
  const impl = ((): Promise<Response> => {
    calls += 1
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => body,
    } as Response)
  }) as unknown as typeof fetch
  return { fetch: impl, calls: () => calls }
}

describe('plugin transport connection budget', () => {
  it('carries every session on one connection', async () => {
    // The reported bug, as an assertion. The plugin opened one stream per
    // session and the overview subscribes one per LISTED session, so a user
    // with a couple of dozen sessions had no connection left for anything
    // else — including the settings panel that would have said so.
    const opened: string[] = []
    const store = new ClaudeProjectionStore({
      open: async path => {
        opened.push(path)
        return new ReadableStream<Uint8Array>({ start: () => {} }).getReader()
      },
      settleMs: 0,
    })
    const drop = Array.from({ length: 25 }, (_value, index) =>
      store.source(`session-${index}`).subscribe(() => {}))
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(opened).toHaveLength(1)
    for (const stop of drop) stop()
    store.dispose()
  })

  it('never lets slow work take the last permit a read could use', async () => {
    // A 150s repository action and a long stream must not be able to starve
    // the diagnostic reads, or the original symptom returns by another route.
    const held = neverAnswers()
    __setPluginFetch(held.fetch)
    void pluginWrite('/w', 'remote').catch(() => undefined)
    void pluginRead('/a', 'git').catch(() => undefined)
    void pluginRead('/b', 'git').catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(held.calls()).toBe(3)
    expect(held.calls()).toBeLessThanOrEqual(PLUGIN_GLOBAL_PERMITS)
  })

  it('fails a starved request fast, and says which failure it was', async () => {
    const held = neverAnswers()
    __setPluginFetch(held.fetch)
    void pluginRead('/a', 'git').catch(() => undefined)
    void pluginRead('/b', 'git').catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 10))

    const started = Date.now()
    const error = await pluginRead('/c', 'git').catch((reason: unknown) => reason as PluginRequestError)
    // Fast and named, rather than twenty silent seconds ending in "signal
    // timed out" — the message that told the user nothing.
    expect(error).toBeInstanceOf(PluginRequestError)
    expect(error.reason).toBe('starved')
    expect(Date.now() - started).toBeLessThan(clientBudgetMs('git'))
    expect(QUEUE_WAIT_BUDGET_MS).toBeLessThan(clientBudgetMs('fast'))
  })

  it('coalesces an overlapping read instead of spending a second permit', async () => {
    const served = answers({ ok: true })
    __setPluginFetch(served.fetch)
    const [first, second] = await Promise.all([
      pluginRead<{ ok: boolean }>('/status', 'git', undefined, { query: { cwd: '/repo' } }),
      pluginRead<{ ok: boolean }>('/status', 'git', undefined, { query: { cwd: '/repo' } }),
    ])

    expect(served.calls()).toBe(1)
    expect(first).toEqual(second)
  })

  it('keeps its deadline when the caller also passes a signal', async () => {
    // The defect this seam exists to prevent: a caller-supplied signal used to
    // overwrite the deadline entirely, and the request could then hold a
    // connection until the page went away.
    const held = neverAnswers()
    __setPluginFetch(held.fetch)
    const caller = new AbortController()
    const failure = pluginRead('/slow', 'fast', caller.signal)
      .catch((reason: unknown) => reason as PluginRequestError)

    await expect(failure).resolves.toBeInstanceOf(PluginRequestError)
    await expect(failure.then(error => error.reason)).resolves.toBe('timeout')
    expect(caller.signal.aborted).toBe(false)
  }, clientBudgetMs('fast') + 5_000)
})
