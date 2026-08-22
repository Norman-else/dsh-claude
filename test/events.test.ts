import { describe, expect, it } from 'vitest'
import {
  boundText,
  latestClaudeContextUsage,
  latestClaudeSessionBinding,
  latestClaudeTasks,
  normalizeActivity,
  normalizeContextUsage,
  normalizeTasksEvent,
  redactValue,
  safeDetail,
} from '../src/events.ts'
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

  it('redacts and bounds visible transcript text', () => {
    const normalized = normalizeActivity({
      turn: 1,
      step: 1,
      ordinal: 0,
      kind: 'text',
      text: `token=raw-secret ${'x'.repeat(70_000)}`,
    })
    expect(normalized.text).not.toContain('raw-secret')
    expect(normalized.text?.length).toBeLessThanOrEqual(64_000)
    expect(normalized.text).toContain('[truncated]')
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

  it('whitelists and bounds aggregate context usage fields', () => {
    const normalized = normalizeContextUsage({
      model: 'claude-opus',
      totalTokens: 131_400.9,
      maxTokens: 272_000,
      percentage: 148,
      categories: [
        { name: 'System prompt', tokens: 3_400.8, color: '#94a3b8' },
        { name: 'Tools', tokens: -4, color: 'url(javascript:alert(1))', isDeferred: true },
      ],
    })
    expect(normalized).toEqual({
      model: 'claude-opus',
      totalTokens: 131_400,
      maxTokens: 272_000,
      percentage: 100,
      categories: [
        { name: 'System prompt', tokens: 3_400, color: '#94a3b8' },
        { name: 'Tools', tokens: 0, color: '#8b95a5', isDeferred: true },
      ],
    })
    expect(normalized).not.toHaveProperty('memoryFiles')
    expect(normalized).not.toHaveProperty('mcpTools')
  })
})

describe('legacy event folds', () => {
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

  it('chooses the newest aggregate context sample', () => {
    const first = { model: 'a', totalTokens: 10, maxTokens: 100, percentage: 10, categories: [] }
    const second = { model: 'b', totalTokens: 20, maxTokens: 100, percentage: 20, categories: [] }
    expect(latestClaudeContextUsage([
      event('claude-code/context-usage', first),
      event('turn/start', {}),
      event('claude-code/context-usage', second),
    ])).toEqual(second)
  })

  it('chooses the newest task board snapshot', () => {
    const first = { tasks: [] }
    const second = { tasks: [{ taskId: 't1', description: 'deploy', status: 'running' }] }
    expect(latestClaudeTasks([
      event('claude-code/tasks', first),
      event('turn/start', {}),
      event('claude-code/tasks', second),
    ])).toEqual(second)
  })
})

describe('task board normalization', () => {
  it('bounds text, clamps usage, and falls back to running for unknown statuses', () => {
    expect(normalizeTasksEvent([
      {
        taskId: 't1',
        description: 'x'.repeat(500),
        status: 'bogus' as never,
        summary: 'y'.repeat(500),
        originTurn: 4.9,
        usage: { totalTokens: -5, toolUses: 3.9, durationMs: 10 },
      },
      {
        taskId: 't2',
        description: 'deploy',
        status: 'completed',
        subagentType: 'ci',
        backgrounded: true,
      },
    ])).toEqual({
      tasks: [
        {
          taskId: 't1',
          description: boundText('x'.repeat(500), 300),
          status: 'running',
          originTurn: 4,
          summary: boundText('y'.repeat(500), 300),
          usage: { totalTokens: 0, toolUses: 3, durationMs: 10 },
        },
        {
          taskId: 't2',
          description: 'deploy',
          status: 'completed',
          subagentType: 'ci',
          backgrounded: true,
        },
      ],
    })
  })

  it('redacts task correlation identifiers on activities', () => {
    expect(normalizeActivity({
      turn: 2,
      step: 1,
      ordinal: 3,
      kind: 'subagent',
      taskId: 'task-token=raw-secret',
    }).taskId).toBe('task-token=[REDACTED]')
  })

  it('drops empty usage records and caps the snapshot size', () => {
    expect(normalizeTasksEvent([{ taskId: 't', description: 'd', status: 'running', usage: {} }]).tasks[0])
      .not.toHaveProperty('usage')
    const many = Array.from({ length: 60 }, (_, index) => ({ taskId: String(index), description: 'd', status: 'running' as const }))
    expect(normalizeTasksEvent(many).tasks).toHaveLength(50)
  })
})
