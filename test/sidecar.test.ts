import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeSidecarRepository, parseClaudeSidecar } from '../src/sidecar.ts'

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
    expect((await stat(store.root)).mode & 0o777).toBe(0o700)
    expect((await stat(join(store.root, files[0]!))).mode & 0o777).toBe(0o600)
    const durable = await readFile(join(store.root, files[0]!), 'utf8')
    expect(durable).not.toContain('raw-secret')
    expect(durable).not.toContain('embedded-secret')
    expect(durable).toContain('[REDACTED]')
  })

  it('rejects malformed persisted documents', () => {
    expect(() => parseClaudeSidecar({ schemaVersion: 2, revision: 0, activities: [] })).toThrow('invalid sidecar')
    expect(() => parseClaudeSidecar({
      schemaVersion: 1,
      revision: 0,
      activities: [{ turn: 1, step: 1, ordinal: 0, kind: 'credential' }],
    })).toThrow('invalid sidecar activity')
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
})
