import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_REPOSITORY_SETUP_PATH } from '../src/constants.ts'
import { BRANCH_LOAD_TIMEOUT_MS, loadRepositoryBranches, parseRepositorySetupEvent, prepareRepository, refreshRepositoryBranches } from '../src/client/repository-setup-api.ts'
import { PLUGIN_ACTION_TIMEOUT_MS } from '../src/client/plugin-request.ts'

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

afterEach(() => {
  vi.unstubAllGlobals()
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
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse([
      '{"type":"progress","stage":"ins',
      'pecting"}\n{"type":"progress","stage":"fetching"}\n',
      `${JSON.stringify({ type: 'complete', result: RESULT })}\n`,
    ])))
    const progress = vi.fn()

    await expect(prepareRepository('/repo', 'main', true, undefined, progress)).resolves.toEqual(RESULT)
    expect(progress.mock.calls).toEqual([['inspecting'], ['fetching']])
  })

  it('rejects malformed events and streams ending before completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse(['{"type":"progress","stage":"unknown"}\n'])))
    await expect(prepareRepository('/repo', 'main', true)).rejects.toThrow('Invalid repository setup progress response.')

    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse(['{"type":"progress","stage":"inspecting"}\n'])))
    await expect(prepareRepository('/repo', 'main', true)).rejects.toThrow('Repository setup progress ended before completion.')
  })

  it('surfaces streamed errors and missing response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse(['{"type":"error","code":"fetch-failed","message":"Fetch failed."}\n'])))
    await expect(prepareRepository('/repo', 'main', true)).rejects.toThrow('Fetch failed.')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    await expect(prepareRepository('/repo', 'main', true)).rejects.toThrow('Repository setup progress stream is unavailable.')
  })

  it('aborts a wedged branch request instead of pending forever', async () => {
    // A host that never answers must not strand the hero in its loading state.
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('timed out')) })
    })))
    const clock = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(clock.signal)

    const pending = loadRepositoryBranches('/repo')
    const assertion = expect(pending).rejects.toThrow('timed out')
    clock.abort()
    await assertion
    expect(timeout).toHaveBeenCalledWith(BRANCH_LOAD_TIMEOUT_MS)
  })

  it('posts a branch refresh on a deadline that outlasts the host git fetch', async () => {
    const branches = { root: '/repo', current: 'main', dirty: false, branches: ['main'], remoteBranches: ['origin/psos-5697'] }
    const request = vi.fn(async () => new Response(JSON.stringify(branches), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', request)
    const timeout = vi.spyOn(AbortSignal, 'timeout')

    await expect(refreshRepositoryBranches('/repo')).resolves.toEqual(branches)
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${CLAUDE_REPOSITORY_SETUP_PATH}/branches/refresh`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ cwd: '/repo' })
    // The host caps `git fetch` at 60s; a shorter client deadline would report
    // a timeout instead of the real reason the remote refused.
    expect(timeout).toHaveBeenCalledWith(PLUGIN_ACTION_TIMEOUT_MS)
    expect(PLUGIN_ACTION_TIMEOUT_MS).toBeGreaterThan(60_000)
  })

  it('names a stale Host instead of reporting the refresh route as missing', async () => {
    // A Host still running the previously loaded server bundle has no refresh
    // route, so the click looks dead until the client says to restart.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )))
    await expect(refreshRepositoryBranches('/repo')).rejects.toThrow('route-missing')
  })

  it('surfaces the host reason a refresh failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'fetch-failed', message: 'Git could not refresh remote references.' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )))
    await expect(refreshRepositoryBranches('/repo')).rejects.toThrow('Git could not refresh remote references.')
  })

  it('passes the caller signal through so an effect cleanup still cancels', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })))
    const controller = new AbortController()
    const pending = loadRepositoryBranches('/repo', controller.signal)
    const assertion = expect(pending).rejects.toThrow('aborted')
    controller.abort()
    await assertion
  })
})
