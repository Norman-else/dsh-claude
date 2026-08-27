import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AskService, askArguments, askPrompt, effortFor, eventsOfStreamLine, toolSummary } from '../src/ask.ts'
import { registerAskRoute } from '../src/ask-routes.ts'
import { CLAUDE_ASK_PATH } from '../src/constants.ts'

function streamingHandle(lines: readonly string[], exitCode = 0, stderr = ''): SubprocessHandle {
  return {
    pid: 1,
    stdin: undefined,
    stdout: Readable.from(lines.map(line => Buffer.from(`${line}\n`))),
    stderr: undefined,
    collected: {
      stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: async () => true,
  } as unknown as SubprocessHandle
}

const delta = (text: string): string => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })

describe('ask prompt and CLI arguments', () => {
  it('quotes the selection and surrounding context and mirrors the session preferences', () => {
    const prompt = askPrompt({ selection: 'PENDING 也落库', context: 'ACH 扣款 … PENDING 也落库 … 打地基', question: '为什么不算已收?' })
    expect(prompt).toContain('Selected passage:\n"""\nPENDING 也落库\n"""')
    expect(prompt).toContain('Surrounding reply, for context only:')
    expect(prompt).toContain('Question: 为什么不算已收?')
    expect(askPrompt({ selection: 'same', context: 'same', question: 'q' })).not.toContain('Surrounding reply')
    expect(askArguments({})).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob',
    ])
    expect(askArguments({ model: 'default', thinkingMode: 'off' })).not.toContain('--model')
    expect(askArguments({ model: 'claude-fable-5', thinkingMode: 'ultracode' })).toEqual(expect.arrayContaining(['--model', 'claude-fable-5', '--effort', 'max']))
    expect(effortFor('high')).toBe('high')
    expect(effortFor('weird')).toBeUndefined()
  })

  it('reads text, thinking, tools, and final results from stream-json lines', () => {
    expect(eventsOfStreamLine(delta('Hel'))).toEqual([{ type: 'text', text: 'Hel' }])
    expect(eventsOfStreamLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } }))).toEqual([{ type: 'thinking', text: 'hmm' }])
    expect(eventsOfStreamLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Grep' } } }))).toEqual([{ type: 'tool', id: 't1', phase: 'start', name: 'Grep' }])
    expect(eventsOfStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'loadURL', path: '/repo' } }] } }))).toEqual([{ type: 'tool', id: 't1', phase: 'input', name: 'Grep', summary: 'loadURL' }])
    expect(eventsOfStreamLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }))).toEqual([{ type: 'tool', id: 't1', phase: 'done', error: true }])
    expect(eventsOfStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Full answer' }))).toEqual([{ type: 'result', text: 'Full answer' }])
    expect(eventsOfStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([{ type: 'status', text: 'ready' }])
    expect(eventsOfStreamLine(JSON.stringify({ type: 'system', subtype: 'other' }))).toEqual([])
    expect(eventsOfStreamLine('not json')).toEqual([])
    expect(toolSummary({ file_path: '/repo/src/index.ts' })).toBe('/repo/src/index.ts')
    expect(toolSummary({ command: 'ls  -la\n' })).toBe('ls -la')
  })
})

describe('ask service', () => {
  it('streams deltas from a tool-free one-shot Claude query in the session cwd', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => streamingHandle([
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Consider cash…' } } }),
      delta('Because '),
      delta('PENDING is not cash.'),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Because PENDING is not cash.' }),
    ]))
    const service = new AskService({ spawn }, '/bin/claude')
    const chunks: string[] = []
    const thoughts: string[] = []
    const statuses: string[] = []
    await service.ask('/repo', { selection: 'PENDING', question: 'why?' }, { model: 'claude-fable-5', thinkingMode: 'high' }, event => {
      if (event.type === 'thinking') thoughts.push(event.text)
      else if (event.type === 'status') statuses.push(event.text)
      else chunks.push(event.text)
    })
    expect(statuses).toEqual(['ready'])
    expect(chunks.join('')).toBe('Because PENDING is not cash.')
    expect(thoughts).toEqual(['Consider cash…'])
    const spec = spawn.mock.calls[0]?.[0]
    expect(spec).toMatchObject({ cwd: '/repo', env: {}, stdio: { stdout: 'pipe' } })
    expect(spec?.argv.slice(0, 6)).toEqual(['/bin/claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'])
    expect(spec?.argv.slice(-8)).toEqual(['--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob'])
    expect(spec?.stdio.stdin).toEqual({ data: expect.stringContaining('Question: why?') })
  })

  it('falls back to the final result and surfaces failures', async () => {
    const onlyResult = new AskService({ spawn: () => streamingHandle([JSON.stringify({ type: 'result', subtype: 'success', result: 'Whole' })]) }, '/bin/claude')
    const chunks: string[] = []
    await onlyResult.ask('/repo', { selection: 's', question: 'q' }, {}, event => chunks.push(event.text))
    expect(chunks).toEqual(['Whole'])

    const failing = new AskService({ spawn: () => streamingHandle([], 1, 'boom: not logged in') }, '/bin/claude')
    await expect(failing.ask('/repo', { selection: 's', question: 'q' }, {}, () => undefined)).rejects.toMatchObject({ code: 'ask-failed', message: 'boom: not logged in' })
    await expect(failing.ask('/repo', { selection: 's', question: '  ' }, {}, () => undefined)).rejects.toMatchObject({ code: 'invalid-request' })
  })
})

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function context(): Context & { handler: Handler } {
  const target = { handler: async () => {} } as { handler: Handler }
  return Object.assign(target, {
    effect: (register: () => unknown) => {
      target.handler = (register() as { handler: Handler }).handler
    },
    webServer: {
      register: (route: { kind: string; path: string; handler: Handler }) => {
        expect(route).toMatchObject({ kind: 'exact', path: CLAUDE_ASK_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(url: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(stream, {
    method: 'POST',
    url,
    headers: { host: 'localhost:56454', origin: 'http://localhost:56454' },
    socket: { remoteAddress: '::1' },
  })
  return stream as IncomingMessage
}

function response(): ServerResponse & { statusCode: number; body: string } {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status; return this },
    write(chunk: string) { this.body += chunk; return true },
    end(chunk?: string) { if (chunk !== undefined) this.body += chunk },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('ask route', () => {
  it('streams deltas as NDJSON for owned sessions and rejects unknown ones', async () => {
    const ctx = context()
    const service = {
      ask: vi.fn(async (_cwd: string, _request: unknown, preferences: unknown, onEvent: (event: { type: 'text' | 'thinking' | 'status'; text: string } | { type: 'tool'; id: string; phase: 'start'; name: string }) => void) => {
        expect(preferences).toEqual({ model: 'claude-fable-5', thinkingMode: 'high' })
        onEvent({ type: 'thinking', text: 'hmm' })
        onEvent({ type: 'tool', id: 't1', phase: 'start', name: 'Read' })
        onEvent({ type: 'text', text: 'Hello ' })
        onEvent({ type: 'text', text: 'world' })
      }),
    }
    registerAskRoute(ctx, service as unknown as AskService, id => (id === 'owned' ? '/repo' : undefined), () => ({ model: 'claude-fable-5', thinkingMode: 'high' }))

    const ok = response()
    await ctx.handler(request(`${CLAUDE_ASK_PATH}?sessionId=owned`, { selection: 'PENDING', context: 'ctx', question: 'why' }), ok)
    expect(ok.statusCode).toBe(200)
    expect(ok.body.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { type: 'thinking', text: 'hmm' },
      { type: 'tool', id: 't1', phase: 'start', name: 'Read' },
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
      { type: 'done' },
    ])
    expect(service.ask.mock.calls[0]?.[0]).toBe('/repo')

    const unknown = response()
    await ctx.handler(request(`${CLAUDE_ASK_PATH}?sessionId=other`, { selection: 'x', question: 'y' }), unknown)
    expect(unknown.statusCode).toBe(409)
    expect(JSON.parse(unknown.body)).toMatchObject({ error: 'session-unavailable' })

    const invalid = response()
    await ctx.handler(request(`${CLAUDE_ASK_PATH}?sessionId=owned`, { question: 'y' }), invalid)
    expect(invalid.statusCode).toBe(409)
    expect(JSON.parse(invalid.body)).toMatchObject({ error: 'invalid-request' })
  })
})
