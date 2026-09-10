import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { withElectronNodeRunner } from '../src/windows-job-runner.ts'

/** A runtime that records what `process.env` looked like while it spawned. */
function recordingRuntime() {
  const calls: { spec: SubprocessSpawnSpec; runAsNodeDuringSpawn: string | undefined }[] = []
  const runtime = {
    resolveExecutable: async (command: string) => command,
    spawn: (spec: SubprocessSpawnSpec) => {
      calls.push({ spec, runAsNodeDuringSpawn: process.env['ELECTRON_RUN_AS_NODE'] })
      return { done: Promise.resolve({ exitCode: 0, signal: null }) } as unknown as SubprocessHandle
    },
    spawnTerminal: async () => { throw new Error('unused') },
  } as unknown as SubprocessRuntime
  return { runtime, calls }
}

const spec: SubprocessSpawnSpec = {
  argv: ['claude', '--version'],
  cwd: 'C:/work',
  stdio: { stdin: 'ignore', stdout: 'collect', stderr: 'collect' },
  env: { PATH: 'C:/bin' },
} as unknown as SubprocessSpawnSpec

describe('Windows Job runner compatibility', () => {
  it('runs the Host runner as Node for the duration of a spawn, and leaves no trace after', () => {
    delete process.env['ELECTRON_RUN_AS_NODE']
    const { runtime, calls } = recordingRuntime()
    const wrapped = withElectronNodeRunner(runtime, { platform: 'win32', electron: true })
    wrapped.spawn(spec)
    expect(calls[0]?.runAsNodeDuringSpawn).toBe('1')
    expect(process.env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })

  it('keeps the flag out of the spawned target itself', () => {
    delete process.env['ELECTRON_RUN_AS_NODE']
    const { runtime, calls } = recordingRuntime()
    withElectronNodeRunner(runtime, { platform: 'win32', electron: true }).spawn(spec)
    // The Host merges `spec.env` over its own environment and drops entries
    // whose value is undefined, which is how the target is told NOT to inherit.
    expect(calls[0]?.spec.env).toMatchObject({ PATH: 'C:/bin', ELECTRON_RUN_AS_NODE: undefined })
    expect(Object.keys(calls[0]?.spec.env ?? {})).toContain('ELECTRON_RUN_AS_NODE')
  })

  it('restores the flag even when the spawn throws', () => {
    delete process.env['ELECTRON_RUN_AS_NODE']
    const runtime = { spawn: () => { throw new Error('boom') } } as unknown as SubprocessRuntime
    const wrapped = withElectronNodeRunner(runtime, { platform: 'win32', electron: true })
    expect(() => wrapped.spawn(spec)).toThrow('boom')
    expect(process.env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })

  it('is a pass-through outside Electron on Windows', () => {
    delete process.env['ELECTRON_RUN_AS_NODE']
    for (const options of [{ platform: 'linux', electron: true }, { platform: 'win32', electron: false }] as const) {
      const { runtime, calls } = recordingRuntime()
      const wrapped = withElectronNodeRunner(runtime, options)
      expect(wrapped).toBe(runtime)
      wrapped.spawn(spec)
      expect(calls[0]?.runAsNodeDuringSpawn).toBeUndefined()
      expect(calls[0]?.spec).toBe(spec)
    }
  })

  it('leaves a Host that already runs as Node alone', () => {
    process.env['ELECTRON_RUN_AS_NODE'] = '1'
    try {
      const { runtime, calls } = recordingRuntime()
      withElectronNodeRunner(runtime, { platform: 'win32', electron: true }).spawn(spec)
      expect(calls[0]?.runAsNodeDuringSpawn).toBe('1')
      expect(process.env['ELECTRON_RUN_AS_NODE']).toBe('1')
    } finally {
      delete process.env['ELECTRON_RUN_AS_NODE']
    }
  })
})
