import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { redactText } from './events.ts'

const VERSION_PATTERN = /(?:Claude Code\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i
const MAX_PROBE_STDOUT = 64 * 1024
const MAX_PROBE_STDERR = 8 * 1024

export type ExecutableRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

export class ClaudeExecutableNotFoundError extends Error {
  readonly searched: readonly string[]

  constructor(searched: readonly string[], options?: ErrorOptions) {
    super(`Claude Code executable not found. Searched: ${searched.join(', ')}`, options)
    this.name = 'ClaudeExecutableNotFoundError'
    this.searched = [...searched]
  }
}

export interface ClaudeExecutableResolution {
  path: string
  searched: readonly string[]
}

export interface ClaudeDoctorReport {
  executable: {
    status: 'found' | 'missing'
    path?: string
    searched: readonly string[]
  }
  version: {
    status: 'ok' | 'error' | 'not-run'
    value?: string
    message?: string
  }
  authentication: {
    status: 'signed-in' | 'signed-out' | 'unknown' | 'not-run'
    method?: string
    provider?: string
    subscription?: string
    message?: string
  }
  handshake: 'not-run' | 'ok' | 'error'
}

function fallbackCandidates(): string[] {
  if (process.platform !== 'darwin') return []
  return [
    join(homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
}

function abortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * Prefer the package's own native binary over a Windows npm shim.
 *
 * A PATH lookup on Windows answers `claude.CMD`, and since the fix for
 * CVE-2024-27980 Node refuses to spawn `.cmd` and `.bat` without
 * `shell: true` — every probe and every session then fails with
 * `spawn EINVAL`, reported to the user as an executable and authentication
 * error with nothing pointing at the file extension. Auto-resolution
 * therefore cannot work on Windows at all, and the user has to discover
 * `executablePath` to get anywhere.
 *
 * npm installs the package beside the shim it writes, and
 * `@anthropic-ai/claude-code` ships a native executable (its own manifest
 * declares `"bin": { "claude": "bin/claude.exe" }`), which carries no such
 * restriction. Falling back to the shim keeps a layout that does not match
 * this assumption working exactly as before.
 *
 * @param path - the resolved candidate, possibly a Windows shim.
 * @returns the native executable when one sits beside the shim, else `path`.
 */
async function preferNativeWindowsBinary(path: string): Promise<string> {
  if (process.platform !== 'win32') return path
  if (!/\.(?:cmd|bat)$/iu.test(path)) return path
  const native = win32.join(
    win32.dirname(path),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  )
  try {
    await access(native, constants.X_OK)
    return native
  } catch {
    return path
  }
}

export async function resolveClaudeExecutable(
  runtime: ExecutableRuntime,
  configuredPath?: string,
  signal?: AbortSignal,
): Promise<ClaudeExecutableResolution> {
  const searched: string[] = []
  const candidates = configuredPath === undefined
    ? ['claude', ...fallbackCandidates()]
    : [configuredPath]
  if (configuredPath !== undefined && !isAbsolute(configuredPath) && !win32.isAbsolute(configuredPath)) {
    throw new Error(`Claude Code executable path must be absolute: ${configuredPath}`)
  }

  let lastError: unknown
  for (const candidate of candidates) {
    if (searched.includes(candidate)) continue
    searched.push(candidate)
    try {
      const resolved = await runtime.resolveExecutable(candidate, undefined, signal)
      return { path: await preferNativeWindowsBinary(resolved), searched }
    } catch (error) {
      if (abortError(error) || signal?.aborted === true) throw error
      lastError = error
    }
  }
  throw new ClaudeExecutableNotFoundError(searched, lastError === undefined ? undefined : { cause: lastError })
}

interface CollectedCommand {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function collect(handle: SubprocessHandle): Promise<CollectedCommand> {
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return { ...outcome, stdout, stderr }
}

async function runProbe(
  runtime: ExecutableRuntime,
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<CollectedCommand> {
  return collect(runtime.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: MAX_PROBE_STDOUT },
      stderr: { maxBytes: MAX_PROBE_STDERR },
    },
    graceMs: 2_000,
    ...(signal === undefined ? {} : { signal }),
    env: {},
  }))
}

export function parseClaudeVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[1]
}

export async function probeClaudeVersion(
  runtime: ExecutableRuntime,
  executable: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runProbe(runtime, executable, ['--version'], cwd, signal)
  const version = parseClaudeVersion(`${result.stdout}\n${result.stderr}`)
  if (result.exitCode !== 0 || version === undefined) {
    throw new Error(`Claude Code version probe failed (${result.exitCode ?? result.signal ?? 'unknown exit'})`)
  }
  return version
}

export async function probeClaudeAuthentication(
  runtime: ExecutableRuntime,
  executable: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ClaudeDoctorReport['authentication']> {
  const result = await runProbe(runtime, executable, ['auth', 'status', '--json'], cwd, signal)
  if (result.exitCode !== 0) {
    return { status: 'unknown', message: 'Claude authentication status command failed' }
  }
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>
    const report: ClaudeDoctorReport['authentication'] = {
      status: value.loggedIn === true ? 'signed-in' : value.loggedIn === false ? 'signed-out' : 'unknown',
    }
    if (typeof value.authMethod === 'string') report.method = redactText(value.authMethod, 100)
    if (typeof value.apiProvider === 'string') report.provider = redactText(value.apiProvider, 100)
    if (typeof value.subscriptionType === 'string') report.subscription = redactText(value.subscriptionType, 100)
    return report
  } catch {
    return { status: 'unknown', message: 'Claude authentication status was not valid JSON' }
  }
}

export async function runClaudeDoctor(
  runtime: ExecutableRuntime,
  options: { configuredPath?: string; cwd: string; signal?: AbortSignal },
): Promise<ClaudeDoctorReport> {
  let resolution: ClaudeExecutableResolution
  try {
    resolution = await resolveClaudeExecutable(runtime, options.configuredPath, options.signal)
  } catch (error) {
    if (error instanceof ClaudeExecutableNotFoundError) {
      return {
        executable: { status: 'missing', searched: error.searched },
        version: { status: 'not-run' },
        authentication: { status: 'not-run' },
        handshake: 'not-run',
      }
    }
    throw error
  }

  const report: ClaudeDoctorReport = {
    executable: { status: 'found', path: resolution.path, searched: resolution.searched },
    version: { status: 'not-run' },
    authentication: { status: 'not-run' },
    handshake: 'not-run',
  }
  try {
    report.version = {
      status: 'ok',
      value: await probeClaudeVersion(runtime, resolution.path, options.cwd, options.signal),
    }
  } catch (error) {
    report.version = {
      status: 'error',
      message: error instanceof Error ? error.message : 'Version probe failed',
    }
  }
  try {
    report.authentication = await probeClaudeAuthentication(runtime, resolution.path, options.cwd, options.signal)
  } catch (error) {
    report.authentication = {
      status: 'unknown',
      message: error instanceof Error ? error.message : 'Authentication probe failed',
    }
  }
  return report
}
