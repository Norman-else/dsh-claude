import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSidecarRepository, parseClaudeSidecar, type ClaudeSidecarDelta } from '../src/sidecar.ts'

const roots: string[] = []

async function repository(): Promise<ClaudeSidecarRepository> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-sidecar-'))
  roots.push(root)
  return new ClaudeSidecarRepository({ root })
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Claude sidecar repository', () => {
  it('returns an empty projection for an unknown session', async () => {
    const store = await repository()
    await expect(store.read('unknown')).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      activities: [],
    })
  })

  it('serializes concurrent writes and keeps ordered activity', async () => {
    const store = await repository()
    await Promise.all([
      store.appendActivity('session', { turn: 1, step: 1, ordinal: 1, kind: 'status', title: 'second' }),
      store.appendActivity('session', { turn: 1, step: 1, ordinal: 0, kind: 'subagent', taskId: 'task', title: 'first' }),
      store.writeTasks('session', [{ taskId: 'task', description: 'work', status: 'running', originTurn: 1 }]),
    ])
    const projection = await store.read('session')
    expect(projection.revision).toBe(3)
    expect(projection.activities.map(item => item.ordinal)).toEqual([0, 1])
    expect(projection.activities[0]?.taskId).toBe('task')
    expect(projection.tasks?.tasks).toEqual([{ taskId: 'task', description: 'work', status: 'running', originTurn: 1 }])
  })

  it('upserts redacted visible transcript text at a stable ordinal', async () => {
    const store = await repository()
    await store.appendActivity('session', {
      turn: 1,
      step: 1,
      ordinal: 0,
      kind: 'text',
      phase: 'updated',
      text: 'Before token=raw-secret',
    })
    await store.appendActivity('session', {
      turn: 1,
      step: 1,
      ordinal: 0,
      kind: 'text',
      phase: 'updated',
      text: 'Before token=raw-secret after',
    })
    const projection = await store.read('session')
    expect(projection.activities).toHaveLength(1)
    expect(projection.activities[0]).toMatchObject({ kind: 'text', phase: 'updated', text: 'Before token=[REDACTED] after' })
  })

  it('persists native question lifecycle without answer content', async () => {
    const store = await repository()
    await store.appendActivity('session', {
      turn: 1,
      step: 1,
      ordinal: 0,
      kind: 'question',
      phase: 'started',
      toolUseId: 'question-1',
      title: 'Claude asked a question',
      summary: 'Which database?',
    })
    await expect(store.read('session')).resolves.toMatchObject({
      activities: [{
        kind: 'question',
        phase: 'started',
        summary: 'Which database?',
      }],
    })
  })

  it('redacts durable values and restricts filesystem permissions', async () => {
    const store = await repository()
    await store.appendActivity('session', {
      turn: 1,
      step: 1,
      ordinal: 0,
      kind: 'tool-call',
      detail: { token: 'raw-secret', command: 'api_key=embedded-secret' },
    })
    await store.writeBinding('session', {
      claudeSessionId: 'claude',
      cwd: '/workspace',
    })
    const files = await readdir(store.root)
    expect(files).toHaveLength(1)
    expect(files[0]).not.toContain('session')
    if (process.platform !== 'win32') {
      expect((await stat(store.root)).mode & 0o777).toBe(0o700)
      expect((await stat(join(store.root, files[0]!))).mode & 0o777).toBe(0o600)
    }
    const durable = await readFile(join(store.root, files[0]!), 'utf8')
    expect(durable).not.toContain('raw-secret')
    expect(durable).not.toContain('embedded-secret')
    expect(durable).toContain('[REDACTED]')
  })

  it('accepts the compaction kind so a compacted session still parses', () => {
    // An unlisted kind fails the whole projection, not just its own row.
    expect(parseClaudeSidecar({
      schemaVersion: 1,
      revision: 0,
      activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'compaction', phase: 'completed' }],
    }).activities).toHaveLength(1)
  })

  it('rejects malformed persisted documents', () => {
    expect(() => parseClaudeSidecar({ schemaVersion: 2, revision: 0, activities: [] })).toThrow('invalid sidecar')
    expect(() => parseClaudeSidecar({
      schemaVersion: 1,
      revision: 0,
      activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'credential' }],
    })).toThrow('invalid sidecar activity')
  })

  it('reads the prior plugin data root and copies it forward on write', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-claude-sidecar-migration-'))
    roots.push(base)
    const root = join(base, 'dsh-claude', 'sessions')
    const legacyRoot = join(base, 'dsh-claude-code', 'sessions')
    const sessionId = 'legacy-session'
    const file = `${Buffer.from(sessionId).toString('base64url')}.json`
    await mkdir(legacyRoot, { recursive: true })
    await writeFile(join(legacyRoot, file), `${JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      activities: [],
      binding: { claudeSessionId: 'legacy', sdkVersion: '0.3.233', cwd: '/workspace' },
    })}\n`)
    const store = new ClaudeSidecarRepository({ root, legacyRoot })

    await expect(store.read(sessionId)).resolves.toMatchObject({ revision: 2, binding: { claudeSessionId: 'legacy' } })
    await store.writeContextUsage(sessionId, { model: 'default', totalTokens: 10, maxTokens: 100, percentage: 10, categories: [] })
    await expect(readFile(join(root, file), 'utf8')).resolves.toContain('legacy')
    await expect(readFile(join(legacyRoot, file), 'utf8')).resolves.not.toContain('contextUsage')
  })

  it('imports readable legacy events idempotently without replacing newer sidecar state', async () => {
    const store = await repository()
    const legacy = [
      { type: 'claude-code/session-bound', data: { claudeSessionId: 'legacy', sdkVersion: '0.3.233', cwd: '/workspace' } },
      { type: 'claude-code/activity', data: { turn: 1, step: 1, ordinal: 0, kind: 'status', title: 'legacy' } },
      { type: 'claude-code/context-usage', data: { model: 'old', totalTokens: 10, maxTokens: 100, percentage: 10, categories: [] } },
      { type: 'claude-code/tasks', data: { tasks: [{ taskId: 'old', description: 'old', status: 'running' }] } },
    ] as never
    const first = await store.importLegacy('session', legacy)
    const second = await store.importLegacy('session', legacy)
    expect(second).toEqual(first)

    await store.writeBinding('session', { claudeSessionId: 'new', cwd: '/workspace' })
    await store.writeContextUsage('session', { model: 'new', totalTokens: 20, maxTokens: 100, percentage: 20, categories: [] })
    const current = await store.importLegacy('session', legacy)
    expect(current.binding?.claudeSessionId).toBe('new')
    expect(current.contextUsage?.model).toBe('new')
    expect(current.activities).toHaveLength(1)
  })

  it('streams transcript appends to subscribers before any disk write', async () => {
    const store = await repository()
    const deltas: ClaudeSidecarDelta[] = []
    const unsubscribe = store.subscribe('session', delta => deltas.push(delta))
    store.appendTranscriptText('session', { turn: 1, step: 1, ordinal: 0, text: 'Hel' })
    store.appendTranscriptText('session', { turn: 1, step: 1, ordinal: 0, text: 'Hello' })
    store.appendTranscriptText('session', { turn: 1, step: 1, ordinal: 0, text: 'Rewritten' })
    expect(deltas).toEqual([
      { kind: 'text', turn: 1, step: 1, ordinal: 0, text: 'Hel', seq: 1 },
      { kind: 'text', turn: 1, step: 1, ordinal: 0, append: 'lo', seq: 2 },
      { kind: 'text', turn: 1, step: 1, ordinal: 0, text: 'Rewritten', seq: 3 },
    ])
    const live = await store.read('session')
    expect(live.revision).toBe(3)
    expect(live.activities).toEqual([expect.objectContaining({ kind: 'text', text: 'Rewritten' })])
    await expect(readdir(store.root)).resolves.toHaveLength(0)
    await store.flushTranscriptText('session')
    await expect(readdir(store.root)).resolves.toHaveLength(1)
    const durable = await store.read('session')
    expect(durable.activities).toEqual([expect.objectContaining({ kind: 'text', text: 'Rewritten' })])
    unsubscribe()
  })

  it('coalesces transcript persistence into the trailing flush window', async () => {
    vi.useFakeTimers()
    try {
      const store = await repository()
      store.appendTranscriptText('session', { turn: 1, step: 1, ordinal: 0, text: 'streaming' })
      await expect(readdir(store.root)).resolves.toHaveLength(0)
      await vi.advanceTimersByTimeAsync(150)
      await store.read('session')
      await expect(readdir(store.root)).resolves.toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('notifies subscribers of durable activity, task, and usage writes', async () => {
    const store = await repository()
    const kinds: string[] = []
    const unsubscribe = store.subscribe('session', delta => kinds.push(delta.kind))
    await store.appendActivity('session', { turn: 1, step: 1, ordinal: 0, kind: 'status', title: 'started' })
    await store.writeTasks('session', [{ taskId: 't', description: 'work', status: 'running' }])
    await store.writeContextUsage('session', { model: 'default', totalTokens: 1, maxTokens: 10, percentage: 10, categories: [] })
    expect(kinds).toEqual(['activity', 'tasks', 'contextUsage'])
    unsubscribe()
  })

  it('numbers every delta per session so a subscriber can tell one was lost', async () => {
    const store = await repository()
    const seen: { session: string; kind: string; seq: number }[] = []
    const stop = ['left', 'right'].map(session => store.subscribe(session, delta => {
      seen.push({ session, kind: delta.kind, seq: delta.seq })
    }))
    await store.appendActivity('left', { turn: 1, step: 1, ordinal: 0, kind: 'status', title: 'one' })
    await store.appendActivity('right', { turn: 1, step: 1, ordinal: 0, kind: 'status', title: 'one' })
    await store.appendActivity('left', { turn: 1, step: 1, ordinal: 1, kind: 'status', title: 'two' })
    // A checkpoint asserts where the stream has reached; it is not itself a
    // delta, so it repeats the last number rather than claiming a new one.
    store.checkpoint('left')
    expect(seen).toEqual([
      { session: 'left', kind: 'activity', seq: 1 },
      { session: 'right', kind: 'activity', seq: 1 },
      { session: 'left', kind: 'activity', seq: 2 },
      { session: 'left', kind: 'checkpoint', seq: 2 },
    ])
    for (const unsubscribe of stop) unsubscribe()
  })

  it('checkpoints a session nobody has written to without inventing a delta', async () => {
    const store = await repository()
    const seen: number[] = []
    const unsubscribe = store.subscribe('quiet', delta => seen.push(delta.seq))
    store.checkpoint('quiet')
    expect(seen).toEqual([0])
    unsubscribe()
  })
})
