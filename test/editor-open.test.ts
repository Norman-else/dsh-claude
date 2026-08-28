import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { EditorOpenError, EditorOpenService } from '../src/editor-open.ts'

function handle(exitCode: number): SubprocessHandle {
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: async () => true,
  }
}

function runtime(exitCodes: number[], known: readonly string[] = ['cursor', 'idea', 'open']) {
  const spawned: SubprocessSpawnSpec[] = []
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
    spawned.push(spec)
    return handle(exitCodes.shift() ?? 0)
  })
  const resolveExecutable = vi.fn(async (name: string) => {
    if (!known.includes(name)) throw new Error(`${name} not found`)
    return `/usr/local/bin/${name}`
  })
  return { spawn, resolveExecutable, spawned }
}

describe('editor open service', () => {
  it('launches the CLI shim with the project directory on macOS', async () => {
    const host = runtime([0])
    await new EditorOpenService(host, 'darwin').open('/repo', 'cursor')

    expect(host.spawned).toHaveLength(1)
    expect(host.spawned[0]?.argv).toEqual(['/usr/local/bin/cursor', '/repo'])
    expect(host.spawned[0]?.cwd).toBe('/repo')
  })

  it('falls back to the macOS bundle opener when the shim is not installed', async () => {
    const host = runtime([0], ['open'])
    await new EditorOpenService(host, 'darwin').open('/repo', 'idea')

    expect(host.spawned[0]?.argv).toEqual(['/usr/local/bin/open', '-a', 'IntelliJ IDEA', '/repo'])
  })

  it('tries the next candidate when a launcher exits non-zero', async () => {
    const host = runtime([1, 0])
    await new EditorOpenService(host, 'darwin').open('/repo', 'cursor')

    expect(host.spawned.map(spec => spec.argv)).toEqual([
      ['/usr/local/bin/cursor', '/repo'],
      ['/usr/local/bin/open', '-a', 'Cursor', '/repo'],
    ])
  })

  it('reports the editor as unavailable when nothing resolves', async () => {
    const host = runtime([], [])
    await expect(new EditorOpenService(host, 'darwin').open('/repo', 'cursor'))
      .rejects.toMatchObject({ code: 'editor-unavailable' })
    expect(host.spawn).not.toHaveBeenCalled()
  })

  it('reports a launch failure when every candidate refuses', async () => {
    const host = runtime([1, 1])
    await expect(new EditorOpenService(host, 'darwin').open('/repo', 'cursor'))
      .rejects.toBeInstanceOf(EditorOpenError)
  })

  it('runs Windows launcher shims through cmd.exe, which Node cannot spawn directly', async () => {
    const host = runtime([0])
    await new EditorOpenService(host, 'win32').open('C:\\repo', 'cursor')

    expect(host.spawned[0]?.argv).toEqual(['cmd.exe', '/d', '/s', '/c', 'cursor', 'C:\\repo'])
    expect(host.resolveExecutable).not.toHaveBeenCalled()
  })

  it('refuses Windows paths cmd.exe would re-interpret rather than opening the wrong project', async () => {
    const host = runtime([0])
    await expect(new EditorOpenService(host, 'win32').open('C:\\a&b', 'cursor'))
      .rejects.toMatchObject({ code: 'unsupported-path' })
    expect(host.spawn).not.toHaveBeenCalled()
  })

  it('treats a still-running IDE binary as launched', async () => {
    const host = runtime([])
    host.spawn.mockImplementationOnce((spec: SubprocessSpawnSpec) => {
      host.spawned.push(spec)
      return { ...handle(0), done: new Promise<never>(() => {}) }
    })
    await new EditorOpenService(host, 'linux', 10).open('/repo', 'idea')

    expect(host.spawned[0]?.argv).toEqual(['/usr/local/bin/idea', '/repo'])
  })
})
