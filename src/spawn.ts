import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import {
  DSH_ENV_PREFIX,
  SENSITIVE_ENV_PATTERN,
  type SubprocessHandle,
  type SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'

export const CLAUDE_PROCESS_GRACE_MS = 2_000
export const CLAUDE_STDERR_TAIL_BYTES = 32 * 1024

const ADDITIONAL_SENSITIVE_ENV_PATTERN = /(?:authorization|cookie|credential|database[_-]?url|private[_-]?key|netrc)/iu

export function scrubClaudeSpawnEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (key.toUpperCase().startsWith(DSH_ENV_PREFIX)) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (ADDITIONAL_SENSITIVE_ENV_PATTERN.test(key)) continue
    safe[key] = value
  }
  return safe
}

/** Where macOS keeps the tools a user's hooks call (`node`, `pnpm`, …). A
 *  Desktop app launched from the Dock inherits launchd's PATH, which has none
 *  of them, so a hook such as `node some-hook.mjs` dies with "command not
 *  found" inside the CLI. Appended, never prepended: the user's own order wins. */
export const MACOS_TOOL_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]

export function appendToolPaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (dir: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  if (platform !== 'darwin' || env.PATH === undefined) return env
  const current = env.PATH.split(':').filter(Boolean)
  const missing = MACOS_TOOL_PATHS.filter(dir => !current.includes(dir) && exists(dir))
  return missing.length === 0 ? env : { ...env, PATH: [...current, ...missing].join(':') }
}

/** The lookup environment for `gh`, `git`, and Claude itself. The Host's own
 *  PATH is launchd's when the app was opened from the Dock, which has none of
 *  the tool directories, so `resolveExecutable('gh')` fails there and every
 *  pull-request lookup silently goes missing. */
export function toolPathEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const PATH = appendToolPaths({ PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }).PATH
  return PATH === undefined ? {} : { PATH }
}

export class ManagedClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly handle: SubprocessHandle
  #killed = false
  #exitCode: number | null = null
  #signalCode: NodeJS.Signals | null = null

  constructor(handle: SubprocessHandle) {
    super()
    if (handle.stdin === undefined || handle.stdout === undefined) {
      throw new Error('dsh-claude: managed Claude process requires piped stdin/stdout')
    }
    this.handle = handle
    this.stdin = handle.stdin
    this.stdout = handle.stdout
    void handle.done.then(
      outcome => {
        this.#exitCode = outcome.exitCode
        this.#signalCode = outcome.signal
        this.emit('exit', outcome.exitCode, outcome.signal)
      },
      error => {
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
      },
    )
  }

  get killed(): boolean {
    return this.#killed
  }

  get exitCode(): number | null {
    return this.#exitCode
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#signalCode
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.#exitCode !== null || this.#signalCode !== null) return false
    this.#killed = true
    this.handle.terminate()
    return true
  }

  stderrTail(): string {
    return this.handle.collected.stderr?.readFrom(0).text ?? ''
  }
}

export type SpawnObserver = (process: ManagedClaudeProcess, options: SpawnOptions) => void

export function createManagedClaudeSpawner(
  runtime: Pick<SubprocessRuntime, 'spawn'>,
  executablePath: string,
  observe?: SpawnObserver,
): (options: SpawnOptions) => SpawnedProcess {
  return options => {
    if (options.command !== executablePath) {
      throw new Error(`dsh-claude: SDK requested unexpected executable ${JSON.stringify(options.command)}`)
    }
    const handle = runtime.spawn({
      argv: [executablePath, ...options.args],
      cwd: options.cwd ?? process.cwd(),
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: CLAUDE_STDERR_TAIL_BYTES },
      },
      graceMs: CLAUDE_PROCESS_GRACE_MS,
      signal: options.signal,
      // Claude Code's native Agent Teams (named in-process teammates, shared
      // task list) are still behind this flag; the plugin renders them.
      // The task tools (TaskCreate / TaskUpdate / TaskList / TaskGet) are off
      // by default for every model newer than the CLI's legacy list (Opus 4.8+,
      // Opus 5.x, Fable, Sonnet 5); they feed the Host to-do dock and the team
      // board, so the plugin opts in. A user's own setting still wins.
      env: appendToolPaths(scrubClaudeSpawnEnv({
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
        ...options.env,
      })),
    })
    const managed = new ManagedClaudeProcess(handle)
    observe?.(managed, options)
    return managed
  }
}
