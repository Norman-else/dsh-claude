import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CLAUDE_PROJECTION,
  createClaudeProjectionSource,
  parseClaudeClientProjection,
} from '../src/client/projection.ts'

const valid = {
  schemaVersion: 1 as const,
  revision: 1,
  owned: true,
  commands: [],
  activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'warning' }],
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Claude client sidecar projection', () => {
  it('validates the bounded public shape', () => {
    expect(parseClaudeClientProjection(valid)).toEqual(valid)
    expect(() => parseClaudeClientProjection({ ...valid, revision: -1 })).toThrow()
    expect(() => parseClaudeClientProjection({ ...valid, owned: undefined })).toThrow()
    expect(() => parseClaudeClientProjection({ ...valid, commands: [{ publicName: 'bad' }] })).toThrow()
    expect(() => parseClaudeClientProjection({ ...valid, activities: [{ turn: 1 }] })).toThrow()
    expect(() => parseClaudeClientProjection({ ...valid, tasks: { tasks: 'not-an-array' } })).toThrow()
  })

  it('loads immediately, polls while subscribed, and stops after unsubscribe', async () => {
    vi.useFakeTimers()
    let revision = 0
    const fetchProjection = vi.fn(async () => {
      revision += 1
      return new Response(JSON.stringify({ ...valid, revision }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session/a', fetchProjection, 100)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    await flush()
    expect(fetchProjection).toHaveBeenCalledTimes(1)
    expect(fetchProjection.mock.calls[0]?.[0]).toContain('session%2Fa')
    expect(source.getSnapshot().revision).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchProjection).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().revision).toBe(2)
    unsubscribe()
    await vi.advanceTimersByTimeAsync(500)
    expect(fetchProjection).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it('degrades a failed refresh to the empty projection and aborts on disposal', async () => {
    vi.useFakeTimers()
    let calls = 0
    let aborted = false
    const fetchProjection = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify(valid), { status: 200 })
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session', fetchProjection, 100)
    const unsubscribe = source.subscribe(() => {})
    await flush()
    expect(source.getSnapshot().revision).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    source.dispose()
    await flush()
    expect(aborted).toBe(true)
    expect(source.getSnapshot()).toEqual(valid)
    unsubscribe()
  })

  it('publishes a command catalog change even when the sidecar revision is unchanged', async () => {
    vi.useFakeTimers()
    let commands = valid.commands
    const fetchProjection = vi.fn(async () => new Response(JSON.stringify({ ...valid, revision: 0, commands }), { status: 200 })) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session', fetchProjection, 100)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    await flush()
    commands = [{
      publicName: 'review',
      claudeName: 'review',
      description: 'Review changes',
      prefixed: false,
    }]
    await vi.advanceTimersByTimeAsync(100)
    expect(source.getSnapshot().commands).toEqual(commands)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    source.dispose()
  })

  it('publishes a preset ownership change even when the sidecar revision is unchanged', async () => {
    vi.useFakeTimers()
    let owned = false
    const fetchProjection = vi.fn(async () => new Response(JSON.stringify({ ...valid, revision: 0, owned }), { status: 200 })) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session', fetchProjection, 100)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    await flush()
    expect(source.getSnapshot().owned).toBe(false)
    owned = true
    await vi.advanceTimersByTimeAsync(100)
    expect(source.getSnapshot().owned).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    source.dispose()
  })

  it('publishes empty state when a non-abort refresh fails', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fetchProjection = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify(valid), { status: 200 })
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session', fetchProjection, 100)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(source.getSnapshot()).toBe(EMPTY_CLAUDE_PROJECTION)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    source.dispose()
  })
})
