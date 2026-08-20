import { EventEmitter } from 'node:events'
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
      env: scrubClaudeSpawnEnv(options.env),
    })
    const managed = new ManagedClaudeProcess(handle)
    observe?.(managed, options)
    return managed
  }
}
