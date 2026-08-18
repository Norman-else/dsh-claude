#!/usr/bin/env node

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { parseClaudeVersion } from './executable.ts'
import { ensureManagedPreset, removeManagedPreset } from './preset-installer.ts'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function executable(configured?: string): Promise<string | undefined> {
  const candidates: string[] = []
  if (configured !== undefined) candidates.push(configured)
  else {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (directory.length > 0) candidates.push(join(directory, 'claude'))
    }
    candidates.push(join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude')
  }
  for (const candidate of [...new Set(candidates)]) {
    if (!isAbsolute(candidate)) continue
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next documented candidate.
    }
  }
  return undefined
}

function run(executablePath: string, args: string[]) {
  return spawnSync(executablePath, args, {
    encoding: 'utf8',
    env: scrubbedParentEnv(),
    timeout: 15_000,
    windowsHide: true,
  })
}

async function doctor(): Promise<number> {
  const configured = option('--executable') ?? process.env.DSH_CLAUDE_CODE_EXECUTABLE
  const path = await executable(configured)
  if (path === undefined) {
    process.stdout.write(`${JSON.stringify({
      executable: { status: 'missing', searched: configured === undefined ? ['claude', '~/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'] : [configured] },
      version: { status: 'not-run' },
      authentication: { status: 'not-run' },
      message: 'Set executablePath to an absolute Claude Code CLI path',
    }, null, 2)}\n`)
    return 1
  }
  const versionProbe = run(path, ['--version'])
  const version = parseClaudeVersion(`${versionProbe.stdout ?? ''}\n${versionProbe.stderr ?? ''}`)
  const authProbe = run(path, ['auth', 'status', '--json'])
  let authentication: Record<string, unknown> = { status: 'unknown' }
  if (authProbe.status === 0) {
    try {
      const value = JSON.parse(authProbe.stdout) as Record<string, unknown>
      authentication = {
        status: value.loggedIn === true ? 'signed-in' : 'signed-out',
        ...(typeof value.authMethod === 'string' ? { method: value.authMethod } : {}),
        ...(typeof value.apiProvider === 'string' ? { provider: value.apiProvider } : {}),
        ...(typeof value.subscriptionType === 'string' ? { subscription: value.subscriptionType } : {}),
      }
    } catch {
      authentication = { status: 'unknown', message: 'Authentication status was not valid JSON' }
    }
  }
  process.stdout.write(`${JSON.stringify({
    executable: { status: 'found', path },
    version: version === undefined ? { status: 'error' } : { status: 'ok', value: version },
    authentication,
    handshake: 'not-run',
  }, null, 2)}\n`)
  return version === undefined ? 1 : 0
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'doctor'
  if (command === 'doctor') return doctor()
  if (command === 'install-preset') {
    process.stdout.write(`${await ensureManagedPreset()}\n`)
    return 0
  }
  if (command === 'remove-preset') {
    process.stdout.write(`${await removeManagedPreset()}\n`)
    return 0
  }
  process.stderr.write(`Usage: dsh-claude-code [doctor [--executable PATH] | install-preset | remove-preset]\n`)
  return 2
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
