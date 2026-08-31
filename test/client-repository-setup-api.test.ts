import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_REPOSITORY_SETUP_PATH } from '../src/constants.ts'
import { loadRepositoryBranches, parseRepositorySetupEvent, prepareRepository, refreshRepositoryBranches } from '../src/client/repository-setup-api.ts'
import { PluginRequestError, __resetPluginTransport, __setPluginFetch } from '../src/client/plugin-transport.ts'
import { clientBudgetMs } from '../src/plugin-budget.ts'

const RESULT = { mode: 'worktree' as const, root: '/repo', path: '/worktree', branch: 'claude/main-x', leaseId: 'lease-1' }

function streamedResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

/** The transport is the only module allowed to name `fetch`, so these tests
 *  drive it through its seam rather than by stubbing the global. */
function serve(impl: (url: string, init: RequestInit) => Promise<Response>): ReturnType<typeof vi.fn> {
  const request = vi.fn(impl)
  __setPluginFetch(request as unknown as typeof fetch)
  return request
}

afterEach(() => {
  // Module-level state: a permit left held here starves the next case.
  __resetPluginTransport()
  vi.restoreAllMocks()
})

describe('repository setup progress API', () => {
  it('parses only bounded progress, complete, and error events', () => {
    const progress = vi.fn()
    expect(parseRepositorySetupEvent('{"type":"progress","stage":"fetching"}', progress)).toBeUndefined()
    expect(progress).toHaveBeenCalledWith('fetching')
    expect(parseRepositorySetupEvent(JSON.stringify({ type: 'complete', result: RESULT }), progress)).toEqual(RESULT)
    expect(() => parseRepositorySetupEvent('{"type":"progress","stage":"git-stderr"}', progress))
      .toThrow('Invalid repository setup progress response.')
    expect(() => parseRepositorySetupEvent('{"type":"error","message":"Fetch failed."}', progress))
      .toThrow('Fetch failed.')
  })

  it('incrementally parses NDJSON lines split across chunks', async () => {
    serve(async () => streamedResponse([
      '{"type":"progress","stage":"ins',
      'pecting"}\n{"type":"progress","stage":"fetching"}\n',
      `${JSON.stringify({ type: 'complete', result: RESULT })}\n`,
    ]))
    const progress = vi.fn()

    await expect(prepareRepository('/repo', 'main', true, undefined, progress)).resolves.toEqual(RESULT)
    expect(progress.mock.calls).toEqual([['inspecting'], ['fetching']])
  })

  it('rejects malformed events and streams ending before completion', async () => {
    serve(async () => streamedResponse(['{"type":"progress","stage":"unknown"}\n']))
    await expect(prepareRepository('/repo', 'main', true)).rejects.toThrow('Invalid repository setup progress response.')

    serve(async () => streamedResponse(['{"type":"progress","stage":"inspecting"}\n']))
    await expect(prepareRepository('/repo', 'main', true)).rejects.toThrow('Repository setup progress ended before completion.')
  })

  it('surfaces streamed errors and missing response bodies', async () => {
    serve(async () => streamedResponse(['{"type":"error","code":"fetch-failed","message":"Fetch failed."}\n']))
    await expect(prepareRepository('/repo', 'main', true)).rejects.toThrow('Fetch failed.')

    // A 200 with no body must fail rather than strand the caller reading a
    // stream that will never arrive; the transport names that failure now.
    serve(async () => new Response(null, { status: 200 }))
    const failure = await prepareRepository('/repo', 'main', true).catch((reason: unknown) => reason as PluginRequestError)
    expect(failure).toBeInstanceOf(PluginRequestError)
    expect(failure.reason).toBe('http')
  })

  it('posts a branch refresh on a deadline that outlasts the host git fetch', async () => {
    const branches = { root: '/repo', current: 'main', dirty: false, branches: ['main'], remoteBranches: ['origin/psos-5697'] }
    const request = serve(async () => new Response(JSON.stringify(branches), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const timeout = vi.spyOn(AbortSignal, 'timeout')

    await expect(refreshRepositoryBranches('/repo')).resolves.toEqual(branches)
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${CLAUDE_REPOSITORY_SETUP_PATH}/branches/refresh`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ cwd: '/repo' })
    // The host caps `git fetch` at 60s; a shorter client deadline would report
    // a timeout instead of the real reason the remote refused. The refresh is
    // declared on the `remote` budget, so the wait it takes is that one.
    expect(timeout).toHaveBeenCalledWith(clientBudgetMs('remote'))
    expect(clientBudgetMs('remote')).toBeGreaterThan(60_000)
  })

  it('names a stale Host instead of reporting the refresh route as missing', async () => {
    // A Host still running the previously loaded server bundle has no refresh
    // route, so the click looks dead until the client says to restart.
    serve(async () => new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ))
    await expect(refreshRepositoryBranches('/repo')).rejects.toThrow('route-missing')
  })

  it('surfaces the host reason a refresh failed', async () => {
    serve(async () => new Response(
      JSON.stringify({ error: 'fetch-failed', message: 'Git could not refresh remote references.' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ))
    await expect(refreshRepositoryBranches('/repo')).rejects.toThrow('Git could not refresh remote references.')
  })

  it('passes the caller signal through so an effect cleanup still cancels', async () => {
    const request = serve((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal
      if (signal === null || signal === undefined) return
      if (signal.aborted) { reject(new Error('aborted')); return }
      signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const controller = new AbortController()
    const failure = loadRepositoryBranches('/repo', controller.signal)
      .catch((reason: unknown) => reason as PluginRequestError)
    // Cancel it once it is genuinely in flight, which is when an effect cleanup
    // that runs mid-request would.
    await vi.waitFor(() => { expect(request).toHaveBeenCalled() })
    controller.abort()

    const error = await failure
    expect(error).toBeInstanceOf(PluginRequestError)
    expect(error.reason).toBe('cancelled')
    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal?.aborted).toBe(true)
  })
})
