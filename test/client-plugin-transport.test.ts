import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PluginRequestError,
  __resetPluginTransport,
  __setPluginFetch,
  pluginNdjson,
  pluginProjectionStream,
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

/** A stream whose body ends the way a server closing the response looks from
 *  here: the reader reports done, and nothing aborts. */
function streamEnding(): typeof fetch {
  return ((): Promise<Response> => Promise.resolve({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({ start: controller => { controller.close() } }),
  } as unknown as Response)) as unknown as typeof fetch
}

/** A stream whose body fails part-way, the other ending the caller does not
 *  cause. */
function streamFailing(): typeof fetch {
  return ((): Promise<Response> => Promise.resolve({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({ start: controller => { controller.error(new Error('connection reset')) } }),
  } as unknown as Response)) as unknown as typeof fetch
}

/** A body that stays open, so the permit is held until something ends it. */
function streamOpen(): typeof fetch {
  return ((): Promise<Response> => Promise.resolve({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({ start: () => {} }),
  } as unknown as Response)) as unknown as typeof fetch
}

describe('stream permits outlive nothing', () => {
  // The carrier permit used to be released only by the caller's abort. A
  // server that closed the response, or a body that failed mid-read, left it
  // held for the life of the page: every reopen answered `starved`, and the
  // transcript stopped updating until the app was restarted.
  it('gives the carrier permit back when the stream ends on its own', async () => {
    __setPluginFetch(streamEnding())
    const first = new AbortController()
    const reader = await pluginProjectionStream('/p/multi?sessions=a', first.signal)
    expect((await reader.read()).done).toBe(true)

    const second = new AbortController()
    await expect(pluginProjectionStream('/p/multi?sessions=a', second.signal)).resolves.toBeDefined()
  })

  it('gives the carrier permit back when the stream fails mid-read', async () => {
    __setPluginFetch(streamFailing())
    const first = new AbortController()
    const reader = await pluginProjectionStream('/p/multi?sessions=a', first.signal)
    await expect(reader.read()).rejects.toThrow()

    const second = new AbortController()
    await expect(pluginProjectionStream('/p/multi?sessions=a', second.signal)).resolves.toBeDefined()
  })

  it('gives the carrier permit back when the reader is cancelled', async () => {
    __setPluginFetch(streamOpen())
    const first = new AbortController()
    const reader = await pluginProjectionStream('/p/multi?sessions=a', first.signal)
    await reader.cancel()

    const second = new AbortController()
    await expect(pluginProjectionStream('/p/multi?sessions=a', second.signal)).resolves.toBeDefined()
  })

  it('gives a counted stream permit back when the stream ends on its own', async () => {
    // The same defect on the lane every other NDJSON route shares.
    __setPluginFetch(streamEnding())
    const first = new AbortController()
    const reader = await pluginNdjson('/ask', first.signal)
    expect((await reader.read()).done).toBe(true)

    const second = new AbortController()
    await expect(pluginNdjson('/ask', second.signal)).resolves.toBeDefined()
  })

  it('still gives the carrier permit back on abort', async () => {
    __setPluginFetch(streamOpen())
    const first = new AbortController()
    await pluginProjectionStream('/p/multi?sessions=a', first.signal)
    first.abort()

    const second = new AbortController()
    await expect(pluginProjectionStream('/p/multi?sessions=a', second.signal)).resolves.toBeDefined()
  })
})
