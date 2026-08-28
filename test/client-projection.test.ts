import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CLAUDE_PROJECTION,
  createClaudeProjectionSource,
  parseClaudeClientProjection,
  selectStepActivities,
} from '../src/client/projection.ts'

const valid = {
  schemaVersion: 1 as const,
  revision: 1,
  owned: true,
  commands: [],
  activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'warning' }],
}

const FRAME_MS = 16

function ndjsonStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const encoder = new TextEncoder()
  return {
    response: new Response(stream, { status: 200 }),
    push(value: unknown) { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)) },
    pushRaw(line: string) { controller.enqueue(encoder.encode(line)) },
    close() {
      try {
        controller.close()
      } catch {
        // already closed
      }
    },
  }
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
    expect(parseClaudeClientProjection({
      ...valid,
      repository: {
        status: 'ready', cwd: '/repo', root: '/repo', branch: 'main', detached: false, worktree: false, dirty: false,
        diff: { additions: 2, deletions: 1, files: 1, patch: 'diff --git a/a b/a\n+new\n', truncated: false },
        pullRequest: {
          number: 1,
          title: 'Status',
          url: 'https://github.com/owner/repo/pull/1',
          state: 'open',
          draft: false,
          review: 'approved',
          checks: 'passing',
        },
      },
    }).repository).toMatchObject({ branch: 'main', diff: { additions: 2, deletions: 1 }, pullRequest: { number: 1 } })
    for (const diff of [
      { additions: -1, deletions: 0, files: 1, truncated: false },
      { additions: 1, deletions: 0, files: 1, truncated: 'false' },
      { additions: 1, deletions: 0, files: 1, patch: 'x'.repeat(256 * 1024 + 1), truncated: false },
    ]) {
      expect(() => parseClaudeClientProjection({
        ...valid,
        repository: { status: 'ready', cwd: '/repo', diff },
      })).toThrow()
    }
    expect(() => parseClaudeClientProjection({
      ...valid,
      repository: {
        status: 'ready', cwd: '/repo',
        pullRequest: {
          number: 1, title: 'bad', url: 'javascript:alert(1)', state: 'open', draft: false, review: 'none', checks: 'none',
        },
      },
    })).toThrow()
  })

  it('validates pending review comments', () => {
    const comment = { id: 'c1', path: 'src/a.ts', line: 12, side: 'new', text: 'Rename this.' }
    expect(parseClaudeClientProjection({ ...valid, reviewComments: [comment] }).reviewComments).toEqual([comment])
    expect(parseClaudeClientProjection({ ...valid, reviewComments: [] }).reviewComments).toEqual([])
    for (const bad of [
      [{ ...comment, id: '' }],
      [{ ...comment, path: '' }],
      [{ ...comment, line: -1 }],
      [{ ...comment, side: 'left' }],
      [{ ...comment, text: 'x'.repeat(2_001) }],
      'not-an-array',
    ]) {
      expect(() => parseClaudeClientProjection({ ...valid, reviewComments: bad })).toThrow()
    }
  })

  it('carries the rewind ranges from the snapshot line into the published projection', async () => {
    vi.useFakeTimers()
    const stream = ndjsonStream()
    const fetchProjection = vi.fn(async () => stream.response) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session/a', fetchProjection, 100)
    const unsubscribe = source.subscribe(() => {})
    stream.push({ ...valid, type: 'snapshot', rewind: { ranges: [{ start: 4, end: 9 }] } })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().rewind).toEqual({ ranges: [{ start: 4, end: 9 }] })
    expect(() => parseClaudeClientProjection({ ...valid, rewind: { ranges: [{ start: -1, end: 2 }] } })).toThrow()
    unsubscribe()
    stream.close()
    source.dispose()
  })

  it('applies the snapshot line and coalesces text appends into one frame', async () => {
    vi.useFakeTimers()
    const stream = ndjsonStream()
    const fetchProjection = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toContain(`${encodeURIComponent('session/a')}/stream`)
      return stream.response
    }) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session/a', fetchProjection, 100)
    expect(source.getSnapshot()).toBe(EMPTY_CLAUDE_PROJECTION)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    stream.push({
      ...valid,
      type: 'snapshot',
      activities: [
        { turn: 1, step: 1, ordinal: 0, kind: 'text', phase: 'updated', text: 'Hel' },
        { turn: 2, step: 1, ordinal: 0, kind: 'warning' },
      ],
    })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().revision).toBe(1)
    const otherStep = selectStepActivities(source.getSnapshot(), 2, 1)
    expect(otherStep).toHaveLength(1)
    stream.push({ type: 'text', turn: 1, step: 1, ordinal: 0, append: 'lo' })
    stream.push({ type: 'text', turn: 1, step: 1, ordinal: 0, append: ' world' })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    // Typewriter smoothing: the arrived burst reveals gradually, not at once.
    const partial = selectStepActivities(source.getSnapshot(), 1, 1)[0]?.text ?? ''
    expect(partial.length).toBeGreaterThan(3)
    expect(partial.length).toBeLessThan(11)
    expect('Hello world'.startsWith(partial)).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    const after = source.getSnapshot()
    expect(selectStepActivities(after, 1, 1)[0]?.text).toBe('Hello world')
    // Untouched steps keep referential identity so their nodes never re-render.
    expect(selectStepActivities(after, 2, 1)).toBe(otherStep)
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2)
    unsubscribe()
    source.dispose()
  })

  it('applies activity and metadata delta lines', async () => {
    vi.useFakeTimers()
    const stream = ndjsonStream()
    const fetchProjection = vi.fn(async () => stream.response) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session', fetchProjection, 100)
    const unsubscribe = source.subscribe(() => {})
    stream.push({ ...valid, type: 'snapshot' })
    stream.push({ type: 'activity', activity: { turn: 1, step: 1, ordinal: 1, kind: 'status', title: 'working' } })
    stream.push({
      type: 'meta',
      owned: true,
      commands: [{ publicName: 'review', claudeName: 'review', description: 'Review changes', prefixed: false }],
      repository: { status: 'ready', cwd: '/repo', root: '/repo', branch: 'feature/x', detached: false, worktree: false, dirty: true },
      reviewComments: [],
    })
    stream.push({ type: 'contextUsage', value: { model: 'default', totalTokens: 5, maxTokens: 10, percentage: 50, categories: [] } })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    const snapshot = source.getSnapshot()
    expect(snapshot.activities.map(activity => activity.ordinal)).toEqual([0, 1])
    expect(snapshot.commands[0]?.publicName).toBe('review')
    expect(snapshot.repository?.branch).toBe('feature/x')
    expect(snapshot.contextUsage?.totalTokens).toBe(5)
    unsubscribe()
    source.dispose()
  })

  it('reconnects with a fresh snapshot after the stream ends', async () => {
    vi.useFakeTimers()
    const first = ndjsonStream()
    const second = ndjsonStream()
    const responses = [first, second]
    const fetchProjection = vi.fn(async () => responses.shift()!.response) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session', fetchProjection, 100)
    const unsubscribe = source.subscribe(() => {})
    first.push({ ...valid, type: 'snapshot' })
    first.close()
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().revision).toBe(1)
    second.push({ ...valid, type: 'snapshot', revision: 5 })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(fetchProjection).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().revision).toBe(5)
    unsubscribe()
    source.dispose()
  })

  it('stops consuming after the last unsubscribe', async () => {
    vi.useFakeTimers()
    const stream = ndjsonStream()
    const fetchProjection = vi.fn(async () => stream.response) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session', fetchProjection, 100)
    const unsubscribe = source.subscribe(() => {})
    stream.push({ ...valid, type: 'snapshot' })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().revision).toBe(1)
    unsubscribe()
    stream.push({ type: 'text', turn: 1, step: 1, ordinal: 9, text: 'late' })
    await flush()
    await vi.advanceTimersByTimeAsync(200)
    expect(source.getSnapshot().revision).toBe(1)
    expect(fetchProjection).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('keeps the last verified state when lines are malformed or invalid', async () => {
    vi.useFakeTimers()
    const stream = ndjsonStream()
    const fetchProjection = vi.fn(async () => stream.response) as unknown as typeof fetch
    const source = createClaudeProjectionSource('session', fetchProjection, 100)
    const unsubscribe = source.subscribe(() => {})
    stream.push({ ...valid, type: 'snapshot' })
    stream.pushRaw('not json\n')
    stream.push({ type: 'activity', activity: { turn: -1 } })
    stream.push({ type: 'text', turn: 1, step: 1, ordinal: 5, append: 'orphan append without base' })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().revision).toBe(1)
    expect(source.getSnapshot().activities).toEqual(valid.activities)
    unsubscribe()
    source.dispose()
  })
})
