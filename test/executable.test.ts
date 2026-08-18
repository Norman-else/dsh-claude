import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import {
  ClaudeExecutableNotFoundError,
  parseClaudeVersion,
  probeClaudeAuthentication,
  resolveClaudeExecutable,
} from '../src/executable.ts'

function handle(stdout: string, stderr = '', outcome: SubprocessOutcome = { exitCode: 0, signal: null }): SubprocessHandle {
  const makeReader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    pid: 1,
    stdin: new PassThrough(),
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: makeReader(stdout), stderr: makeReader(stderr) },
    done: Promise.resolve(outcome),
    terminate: () => undefined,
    waitForExit: async () => true,
  }
}

describe('Claude executable resolution', () => {
  it('prefers the configured path and does not inspect PATH', async () => {
    const calls: string[] = []
    const runtime = {
      resolveExecutable: async (candidate: string) => { calls.push(candidate); return '/resolved/claude' },
      spawn: () => handle(''),
    }
    await expect(resolveClaudeExecutable(runtime, '/custom/claude')).resolves.toEqual({
      path: '/resolved/claude',
      searched: ['/custom/claude'],
    })
    expect(calls).toEqual(['/custom/claude'])
  })

  it('falls back after PATH resolution fails', async () => {
    const calls: string[] = []
    const runtime = {
      resolveExecutable: async (candidate: string) => {
        calls.push(candidate)
        if (candidate === 'claude') throw new Error('missing')
        return candidate
      },
      spawn: () => handle(''),
    }
    const resolved = await resolveClaudeExecutable(runtime)
    expect(resolved.path).toMatch(/\.local\/bin\/claude$/)
    expect(calls[0]).toBe('claude')
  })

  it('reports every searched candidate when missing', async () => {
    const runtime = {
      resolveExecutable: async () => { throw new Error('missing') },
      spawn: () => handle(''),
    }
    await expect(resolveClaudeExecutable(runtime)).rejects.toBeInstanceOf(ClaudeExecutableNotFoundError)
  })
})

describe('Doctor probes', () => {
  it('parses current and prefixed version output', () => {
    expect(parseClaudeVersion('2.1.233 (Claude Code)')).toBe('2.1.233')
    expect(parseClaudeVersion('Claude Code v2.1.233')).toBe('2.1.233')
  })

  it('returns only non-sensitive authentication categories', async () => {
    const runtime = {
      resolveExecutable: async () => '/claude',
      spawn: () => handle(JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
        email: 'private@example.com',
        token: 'secret',
      })),
    }
    const report = await probeClaudeAuthentication(runtime, '/claude', '/workspace')
    expect(report).toEqual({
      status: 'signed-in',
      method: 'claude.ai',
      provider: 'firstParty',
      subscription: 'max',
    })
    expect(JSON.stringify(report)).not.toContain('private@example.com')
    expect(JSON.stringify(report)).not.toContain('secret')
  })
})
