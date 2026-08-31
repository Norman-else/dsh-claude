import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeProjectionStore,
  EMPTY_CLAUDE_PROJECTION,
  parseClaudeClientProjection,
  selectStepActivities,
} from '../src/client/projection.ts'
import { CLAUDE_PROJECTION_PATH } from '../src/constants.ts'

const valid = {
  schemaVersion: 1 as const,
  revision: 1,
  owned: true,
  commands: [],
  activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'warning' }],
}

const FRAME_MS = 16
const RETRY_MS = 100

interface Carrier {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  /** Publish one carrier line, stamped with the session that owns it. */
  push(session: string, value: object): void
  pushRaw(line: string): void
  close(): void
}

/** One multiplexed NDJSON carrier, handed to the store as an open reader. */
function carrier(): Carrier {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const encoder = new TextEncoder()
  return {
    reader: stream.getReader(),
    push(session, value) {
      controller.enqueue(encoder.encode(`${JSON.stringify({ ...value, session })}\n`))
    },
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

/** A store whose single carrier is ours, so a test can observe exactly how
 *  many connections the plugin opens and what it asked for. */
function projectionStore(planned: readonly Carrier[] = []) {
  const queued = [...planned]
  const opened: string[] = []
  const signals: AbortSignal[] = []
  const store = new ClaudeProjectionStore({
    open: async (path, cancel) => {
      opened.push(path)
      signals.push(cancel)
      // An unplanned open is not thrown away silently: `opened` records it and
      // the connection-count assertions fail on it.
      return (queued.shift() ?? carrier()).reader
    },
    retryDelayMs: RETRY_MS,
    settleMs: 0,
  })
  return { store, opened, signals }
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

  it('carries every subscribed session over a single connection', async () => {
    // The bug this branch exists to fix. The overview subscribes one source per
    // LISTED session; when each source opened its own stream the plugin ate the
    // browser's whole per-origin budget and its own settings panel could no
    // longer get a connection.
    vi.useFakeTimers()
    const stream = carrier()
    const { store, opened } = projectionStore([stream])
    const sessions = Array.from({ length: 12 }, (_value, index) => `session-${index}`)
    const stop = sessions.map(id => store.source(id).subscribe(() => {}))
    await flush()

    expect(opened).toEqual([
      `${CLAUDE_PROJECTION_PATH}/multi?sessions=${sessions.map(encodeURIComponent).join(',')}`,
    ])
    // One carrier, still demultiplexed: each session sees only its own lines.
    stream.push('session-3', { ...valid, type: 'snapshot' })
    stream.push('session-7', { ...valid, type: 'snapshot', revision: 5 })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(store.source('session-3').getSnapshot().revision).toBe(1)
    expect(store.source('session-7').getSnapshot().revision).toBe(5)
    expect(store.source('session-0').getSnapshot()).toBe(EMPTY_CLAUDE_PROJECTION)
    // Nothing opens a second connection later either, however long we wait.
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(opened).toHaveLength(1)
    for (const unsubscribe of stop) unsubscribe()
    stream.close()
    store.dispose()
  })

  it('carries the rewind ranges from the snapshot line into the published projection', async () => {
    vi.useFakeTimers()
    const stream = carrier()
    const { store } = projectionStore([stream])
    const source = store.source('session/a')
    const unsubscribe = source.subscribe(() => {})
    await flush()
    stream.push('session/a', { ...valid, type: 'snapshot', rewind: { ranges: [{ start: 4, end: 9 }] } })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().rewind).toEqual({ ranges: [{ start: 4, end: 9 }] })
    expect(() => parseClaudeClientProjection({ ...valid, rewind: { ranges: [{ start: -1, end: 2 }] } })).toThrow()
    unsubscribe()
    stream.close()
    store.dispose()
  })

  it('applies the snapshot line and coalesces text appends into one frame', async () => {
    vi.useFakeTimers()
    const stream = carrier()
    const { store, opened } = projectionStore([stream])
    const source = store.source('session/a')
    expect(source.getSnapshot()).toBe(EMPTY_CLAUDE_PROJECTION)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    await flush()
    // The session id reaches the carrier encoded, as one lane of the multiplex.
    expect(opened[0]).toBe(`${CLAUDE_PROJECTION_PATH}/multi?sessions=${encodeURIComponent('session/a')}`)
    stream.push('session/a', {
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
    stream.push('session/a', { type: 'text', turn: 1, step: 1, ordinal: 0, append: 'lo' })
    stream.push('session/a', { type: 'text', turn: 1, step: 1, ordinal: 0, append: ' world' })
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
    stream.close()
    store.dispose()
  })

  it('applies activity and metadata delta lines', async () => {
    vi.useFakeTimers()
    const stream = carrier()
    const { store } = projectionStore([stream])
    const source = store.source('session')
    const unsubscribe = source.subscribe(() => {})
    await flush()
    stream.push('session', { ...valid, type: 'snapshot' })
    stream.push('session', { type: 'activity', activity: { turn: 1, step: 1, ordinal: 1, kind: 'status', title: 'working' } })
    stream.push('session', {
      type: 'meta',
      owned: true,
      commands: [{ publicName: 'review', claudeName: 'review', description: 'Review changes', prefixed: false }],
      repository: { status: 'ready', cwd: '/repo', root: '/repo', branch: 'feature/x', detached: false, worktree: false, dirty: true },
      reviewComments: [],
    })
    stream.push('session', { type: 'contextUsage', value: { model: 'default', totalTokens: 5, maxTokens: 10, percentage: 50, categories: [] } })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    const snapshot = source.getSnapshot()
    expect(snapshot.activities.map(activity => activity.ordinal)).toEqual([0, 1])
    expect(snapshot.commands[0]?.publicName).toBe('review')
    expect(snapshot.repository?.branch).toBe('feature/x')
    expect(snapshot.contextUsage?.totalTokens).toBe(5)
    unsubscribe()
    stream.close()
    store.dispose()
  })

  it('reconnects with a fresh snapshot after the carrier ends', async () => {
    vi.useFakeTimers()
    const first = carrier()
    const second = carrier()
    const { store, opened } = projectionStore([first, second])
    const source = store.source('session')
    const unsubscribe = source.subscribe(() => {})
    await flush()
    first.push('session', { ...valid, type: 'snapshot' })
    first.close()
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().revision).toBe(1)
    second.push('session', { ...valid, type: 'snapshot', revision: 5 })
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(opened).toHaveLength(2)
    expect(source.getSnapshot().revision).toBe(5)
    unsubscribe()
    second.close()
    store.dispose()
  })

  it('stops consuming after the last unsubscribe', async () => {
    vi.useFakeTimers()
    const stream = carrier()
    const { store, opened, signals } = projectionStore([stream])
    const source = store.source('session')
    const unsubscribe = source.subscribe(() => {})
    await flush()
    stream.push('session', { ...valid, type: 'snapshot' })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().revision).toBe(1)
    unsubscribe()
    await flush()
    // The carrier is released rather than held open for nobody.
    expect(signals[0]?.aborted).toBe(true)
    stream.push('session', { type: 'text', turn: 1, step: 1, ordinal: 9, text: 'late' })
    await flush()
    await vi.advanceTimersByTimeAsync(200)
    expect(source.getSnapshot().revision).toBe(1)
    expect(opened).toHaveLength(1)
    stream.close()
    store.dispose()
  })

  it('keeps the last verified state when lines are malformed or invalid', async () => {
    vi.useFakeTimers()
    const stream = carrier()
    const { store } = projectionStore([stream])
    const source = store.source('session')
    const unsubscribe = source.subscribe(() => {})
    await flush()
    stream.push('session', { ...valid, type: 'snapshot' })
    stream.pushRaw('not json\n')
    stream.push('session', { type: 'activity', activity: { turn: -1 } })
    stream.push('session', { type: 'text', turn: 1, step: 1, ordinal: 5, append: 'orphan append without base' })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().revision).toBe(1)
    expect(source.getSnapshot().activities).toEqual(valid.activities)
    // The carrier survived the bad lines: the next good one still lands.
    stream.push('session', { type: 'activity', activity: { turn: 1, step: 1, ordinal: 1, kind: 'status', title: 'working' } })
    await flush()
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    expect(source.getSnapshot().activities.map(activity => activity.ordinal)).toEqual([0, 1])
    unsubscribe()
    stream.close()
    store.dispose()
  })
})
