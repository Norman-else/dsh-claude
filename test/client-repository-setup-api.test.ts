import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRANCH_LOAD_TIMEOUT_MS, loadRepositoryBranches, parseRepositorySetupEvent, prepareRepository } from '../src/client/repository-setup-api.ts'

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
