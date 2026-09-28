import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  ManagedClaudeProcess,
  createManagedClaudeSpawner,
  scrubClaudeSpawnEnv,
  appendToolPaths,
  MACOS_TOOL_PATHS,
  toolPathEnv,
} from '../src/spawn.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fakeHandle() {
  const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const terminate = vi.fn()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const handle: SubprocessHandle = {
    pid: 42,
    stdin,
    stdout,
    stderr: undefined,
    collected: { stderr: { readFrom: () => ({ text: 'tail', nextOffset: 4, lossy: false }) } },
    done: exit.promise,
    terminate,
    waitForExit: async () => true,
  }
  return { handle, exit, terminate }
}

describe('managed Claude process', () => {
  it('maps DSH completion into SDK exit events', async () => {
    const fake = fakeHandle()
    const process = new ManagedClaudeProcess(fake.handle)
    const exited = new Promise(resolve => process.once('exit', (code, signal) => resolve({ code, signal })))
    fake.exit.resolve({ exitCode: 0, signal: null })
    await expect(exited).resolves.toEqual({ code: 0, signal: null })
    expect(process.exitCode).toBe(0)
    expect(process.stderrTail()).toBe('tail')
  })

  it('uses DSH tree termination for SDK kill', () => {
    const fake = fakeHandle()
    const process = new ManagedClaudeProcess(fake.handle)
    expect(process.kill('SIGKILL')).toBe(true)
    expect(process.killed).toBe(true)
    expect(fake.terminate).toHaveBeenCalledOnce()
  })
})

describe('managed spawner', () => {
  it('passes exact argv and removes credential-shaped environment', () => {
    const fake = fakeHandle()
    let spec: SubprocessSpawnSpec | undefined
    const spawn = createManagedClaudeSpawner({ spawn: value => { spec = value; return fake.handle } }, '/local/claude')
    const options: SpawnOptions = {
      command: '/local/claude',
      args: ['--sdk-url', 'stdio'],
      cwd: '/workspace',
      env: {
        HOME: '/Users/test',
        ANTHROPIC_API_KEY: 'secret',
        GITHUB_TOKEN: 'secret-two',
        AUTHORIZATION: 'Bearer secret-three',
        COOKIE: 'session=secret-four',
        DATABASE_URL: 'postgres://user:pass@host/db',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-claude/0.1.0',
        DSH_SESSION_ID: 'private-host-context',
      },
      signal: new AbortController().signal,
    }
    spawn(options)
    expect(spec?.argv).toEqual(['/local/claude', '--sdk-url', 'stdio'])
    expect(spec?.cwd).toBe('/workspace')
    expect(spec?.env).toEqual({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      HOME: '/Users/test',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-claude/0.1.0',
    })
  })

  it('rejects an SDK request to spawn a different executable', () => {
    const fake = fakeHandle()
    const spawn = createManagedClaudeSpawner({ spawn: () => fake.handle }, '/local/claude')
    expect(() => spawn({
      command: '/tmp/not-claude',
      args: [],
      env: {},
      signal: new AbortController().signal,
    })).toThrow(/unexpected executable/)
  })

  it('scrubs environment keys case-insensitively', () => {
    expect(scrubClaudeSpawnEnv({ password: 'x', Dsh_fact: 'x', PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it('appends the macOS tool directories a Dock-launched app never inherits', () => {
    const exists = (dir: string) => dir === '/opt/homebrew/bin'
    expect(appendToolPaths({ PATH: '/usr/bin:/bin' }, 'darwin', exists)).toEqual({ PATH: '/usr/bin:/bin:/opt/homebrew/bin' })
    // The user's own order wins, and a directory already there is not repeated.
    expect(appendToolPaths({ PATH: '/opt/homebrew/bin:/usr/bin' }, 'darwin', exists)).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin' })
    expect(appendToolPaths({ PATH: '/usr/bin' }, 'linux', () => true)).toEqual({ PATH: '/usr/bin' })
    expect(appendToolPaths({}, 'darwin', () => true)).toEqual({})
    expect(MACOS_TOOL_PATHS[0]).toBe('/opt/homebrew/bin')
  })

  it('hands executable lookup a PATH even when the Host has none', () => {
    expect(toolPathEnv({}).PATH).toContain('/usr/bin')
    expect(toolPathEnv({ PATH: '/x' }).PATH?.startsWith('/x')).toBe(true)
  })
})
