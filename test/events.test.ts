import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  boundText,
  latestClaudeSessionBinding,
  normalizeActivity,
  redactValue,
  safeDetail,
} from '../src/events.ts'
import {
  installClaudeEventVocabulary,
  registerClaudeEventVocabulary,
  resolveHostSessionModulePath,
} from '../src/event-vocabulary.ts'

const event = (type: string, data: unknown) => ({
  id: crypto.randomUUID(),
  type,
  data,
  timestamp: Date.now(),
}) as never

describe('event normalization', () => {
  it('redacts credential-shaped keys recursively', () => {
    expect(redactValue({
      token: 'abc',
      nested: { api_key: 'def', okay: 'visible' },
      list: [{ password: 'ghi' }],
    })).toEqual({
      token: '[REDACTED]',
      nested: { api_key: '[REDACTED]', okay: 'visible' },
      list: [{ password: '[REDACTED]' }],
    })
  })

  it('redacts whole environment maps keyed as env/environment', () => {
    expect(redactValue({
      env: { PATH: '/usr/bin', GOOGLE_APPLICATION_CREDENTIALS: '/secrets/sa.json', PLAIN: 'kept-string' },
      environment: { DATABASE_URL: 'postgres://u:p@h/db' },
    })).toEqual({
      env: '[REDACTED]',
      environment: '[REDACTED]',
    })
  })

  it('redacts credentials embedded inside command and URL strings', () => {
    const detail = safeDetail({
      command: 'TOKEN=plain curl -H "Authorization: Bearer bearer-value" https://user:pass@example.test/?api_key=query-value',
      provider: 'sk-ant-abcdefghijklmno',
    })
    expect(detail).not.toContain('plain')
    expect(detail).not.toContain('bearer-value')
    expect(detail).not.toContain(':pass@')
    expect(detail).not.toContain('query-value')
    expect(detail).not.toContain('sk-ant-abcdefghijklmno')
    expect(detail?.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('redacts embedded credentials from summaries and errors', () => {
    const normalized = normalizeActivity({
      turn: 1,
      step: 2,
      ordinal: 0,
      kind: 'error',
      summary: 'access_token=raw-token',
      detail: new Error('Authorization: Bearer raw-bearer'),
    })
    expect(normalized.summary).not.toContain('raw-token')
    expect(normalized.detail).not.toContain('raw-bearer')
  })

  it('bounds persisted summaries and details', () => {
    const normalized = normalizeActivity({
      turn: 1,
      step: 2,
      ordinal: 0,
      kind: 'tool-call',
      summary: 's'.repeat(2_000),
      detail: { output: 'd'.repeat(10_000) },
    })
    expect(normalized.summary?.length).toBeLessThanOrEqual(1_000)
    expect(normalized.detail?.length).toBeLessThanOrEqual(4_000)
    expect(normalized.summary).toContain('[truncated]')
  })

  it('returns JSON detail without functions, circular references, or secrets', () => {
    const input: Record<string, unknown> = { secret: 'nope', value: 1, fn: () => undefined }
    input.self = input
    const detail = safeDetail(input)
    expect(detail).toContain('"secret":"[REDACTED]"')
    expect(detail).toContain('"self":"[circular]"')
    expect(detail).not.toContain('nope')
  })

  it('preserves short text', () => {
    expect(boundText('hello', 10)).toBe('hello')
  })
})

const installedHostEntrypoint = '/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js'

describe('host event vocabulary installation', () => {
  it('registers both plugin event types on the supplied runtime singleton', () => {
    const vocabulary = new Set<string>(['turn/start'])
    registerClaudeEventVocabulary({ KNOWN_SESSION_EVENT_TYPES: vocabulary })
    expect(vocabulary).toEqual(new Set([
      'turn/start',
      'claude-code/session-bound',
      'claude-code/activity',
    ]))
  })

  it('resolves the session module relative to the running Host entrypoint', () => {
    let observedSpecifier = ''
    let observedParent = ''
    const resolved = resolveHostSessionModulePath(
      installedHostEntrypoint,
      (specifier, parent) => {
        observedSpecifier = specifier
        observedParent = String(parent)
        return '/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh-session/lib/index.js'
      },
    )
    expect(observedSpecifier).toBe('@deepseek-ai/dsh-session')
    expect(observedParent).toBe('file:///Applications/DeepSeek%20Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(resolved).toContain('/Resources/host/node_modules/@deepseek-ai/dsh-session/lib/index.js')
  })

  it.runIf(existsSync(installedHostEntrypoint))('mutates the installed Host module instance instead of the linked checkout copy', async () => {
    const hostSessionPath = resolveHostSessionModulePath(installedHostEntrypoint)
    const hostSession = await import(pathToFileURL(hostSessionPath).href) as {
      KNOWN_SESSION_EVENT_TYPES: Set<string>
    }
    const initiallyKnown = hostSession.KNOWN_SESSION_EVENT_TYPES.has('claude-code/activity')
    try {
      await installClaudeEventVocabulary(installedHostEntrypoint)
      expect(hostSession.KNOWN_SESSION_EVENT_TYPES.has('claude-code/activity')).toBe(true)
      expect(hostSession.KNOWN_SESSION_EVENT_TYPES.has('claude-code/session-bound')).toBe(true)
    } finally {
      if (!initiallyKnown) {
        hostSession.KNOWN_SESSION_EVENT_TYPES.delete('claude-code/activity')
        hostSession.KNOWN_SESSION_EVENT_TYPES.delete('claude-code/session-bound')
      }
    }
  })
})

describe('session binding fold', () => {
  it('chooses the newest Claude binding only', () => {
    const first = { claudeSessionId: 'one', sdkVersion: '0.3.233', cwd: '/a' }
    const second = { claudeSessionId: 'two', sdkVersion: '0.3.233', cwd: '/b' }
    expect(latestClaudeSessionBinding([
      event('claude-code/session-bound', first),
      event('turn/start', {}),
      event('claude-code/session-bound', second),
    ])).toEqual(second)
  })

  it('returns undefined for an unbound session', () => {
    expect(latestClaudeSessionBinding([event('turn/start', {})])).toBeUndefined()
  })
})
