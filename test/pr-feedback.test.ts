import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CLAUDE_REPOSITORY_FEEDBACK_PATH } from '../src/constants.ts'
import { registerPullRequestFeedbackRoute } from '../src/pr-feedback-routes.ts'
import {
  PullRequestFeedbackService,
  actionsJobId,
  boundedLogTail,
  parseFailingChecks,
  parseReviewComments,
} from '../src/pr-feedback.ts'

interface Result { readonly stdout?: string; readonly exitCode?: number }

function handle(result: Result): SubprocessHandle {
  const stdout = result.stdout ?? ''
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: async () => true,
  }
}

function runtime(results: Result[]) {
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => {
    const result = results.shift()
    if (result === undefined) throw new Error('unexpected command')
    return handle(result)
  })
  return { spawn, resolveExecutable: vi.fn(async (name: string) => `/bin/${name}`) }
}

describe('pull request feedback parsing', () => {
  it('maps review comments with side, line fallback, and author', () => {
    expect(parseReviewComments([
      { id: 1, path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Fix this', html_url: 'https://github.com/x', user: { login: 'alice' } },
      { id: 2, path: 'src/b.ts', line: null, original_line: 4, side: 'LEFT', body: 'Old code', html_url: 'https://github.com/y', user: { login: 'bob' } },
      { id: 3, path: 'src/c.ts', line: 1, side: 'RIGHT', body: '   ', html_url: 'https://github.com/z', user: { login: 'carol' } },
    ])).toEqual([
      { id: 1, path: 'src/a.ts', line: 12, side: 'new', author: 'alice', body: 'Fix this', url: 'https://github.com/x' },
      { id: 2, path: 'src/b.ts', line: 4, side: 'old', author: 'bob', body: 'Old code', url: 'https://github.com/y' },
    ])
  })

  it('keeps only failing check buckets and extracts Actions job ids', () => {
    expect(parseFailingChecks([
      { name: 'build', state: 'FAILURE', bucket: 'fail', link: 'https://github.com/o/r/actions/runs/9/job/77', description: 'exited 1' },
      { name: 'lint', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/o/r/actions/runs/9/job/78' },
    ])).toEqual([
      { name: 'build', link: 'https://github.com/o/r/actions/runs/9/job/77', description: 'exited 1' },
    ])
    expect(actionsJobId('https://github.com/o/r/actions/runs/9/job/77')).toBe('77')
    expect(actionsJobId('https://example.com/status')).toBeUndefined()
    expect(actionsJobId(undefined)).toBeUndefined()
  })

  it('bounds failure logs to their informative tail', () => {
    const long = `${'x'.repeat(10_000)}TAIL`
    expect(boundedLogTail(long).endsWith('TAIL')).toBe(true)
    expect(boundedLogTail(long).length).toBe(8 * 1024)
    expect(boundedLogTail('short\n')).toBe('short')
  })
})

describe('pull request feedback service', () => {
  it('loads paginated review comments through gh api', async () => {
    const fake = runtime([
      { stdout: 'git@github.com:Mercaso/store.git\n' },
      { stdout: '[{"id":1,"path":"a.ts","line":2,"side":"RIGHT","body":"Hi","html_url":"https://github.com/x","user":{"login":"alice"}}][{"id":2,"path":"b.ts","line":3,"side":"RIGHT","body":"Yo","html_url":"https://github.com/y","user":{"login":"bob"}}]' },
    ])
    const service = new PullRequestFeedbackService(fake)
    const comments = await service.comments('/repo', 12)
    expect(comments.map(comment => comment.id)).toEqual([1, 2])
    expect(fake.spawn.mock.calls[1]?.[0].argv).toEqual(['/bin/gh', 'api', 'repos/Mercaso/store/pulls/12/comments', '--paginate'])
  })

  it('collects failing checks and fetches Actions job logs', async () => {
    const fake = runtime([
      { stdout: '[{"name":"build","bucket":"fail","link":"https://github.com/o/r/actions/runs/9/job/77"},{"name":"external","bucket":"fail","link":"https://ci.example.com/1"}]', exitCode: 1 },
      { stdout: 'error: build exploded\n' },
    ])
    const service = new PullRequestFeedbackService(fake)
    const checks = await service.failingChecks('/repo', 12)
    expect(checks).toEqual([
      { name: 'build', link: 'https://github.com/o/r/actions/runs/9/job/77', log: 'error: build exploded' },
      { name: 'external', link: 'https://ci.example.com/1' },
    ])
    expect(fake.spawn.mock.calls[0]?.[0].argv).toEqual(['/bin/gh', 'pr', 'checks', '12', '--json', 'name,state,link,description,bucket'])
    expect(fake.spawn.mock.calls[1]?.[0].argv).toEqual(['/bin/gh', 'run', 'view', '--job', '77', '--log-failed'])
  })

  it('rejects repositories without a GitHub origin remote', async () => {
    const fake = runtime([{ stdout: 'https://gitlab.com/x/y.git\n' }])
    await expect(new PullRequestFeedbackService(fake).comments('/repo', 1))
      .rejects.toMatchObject({ code: 'no-github-remote' })
  })
})

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function context(): Context & { handler: Handler } {
  const target = { handler: async () => {} } as { handler: Handler }
  return Object.assign(target, {
    effect: (register: () => unknown) => {
      const route = register() as { handler: Handler }
      target.handler = route.handler
    },
    webServer: {
      register: (route: { kind: string; path: string; handler: Handler }) => {
        expect(route).toMatchObject({ kind: 'prefix', path: CLAUDE_REPOSITORY_FEEDBACK_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(url: string): IncomingMessage {
  const stream = Readable.from([])
  Object.assign(stream, {
    method: 'GET',
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
    end(body: string) { this.body = body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('pull request feedback route', () => {
  it('binds comments and checks to the session cwd and validates the number', async () => {
    const ctx = context()
    const service = {
      comments: vi.fn(async () => []),
      failingChecks: vi.fn(async () => []),
    }
    registerPullRequestFeedbackRoute(ctx, service as unknown as PullRequestFeedbackService, id => id === 'owned' ? '/repo' : undefined)

    const ok = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/comments?sessionId=owned&number=12`), ok)
    expect(ok.statusCode).toBe(200)
    expect(service.comments).toHaveBeenCalledWith('/repo', 12)

    const checks = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/checks?sessionId=owned&number=7`), checks)
    expect(checks.statusCode).toBe(200)
    expect(service.failingChecks).toHaveBeenCalledWith('/repo', 7)

    const badNumber = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/comments?sessionId=owned&number=nope`), badNumber)
    expect(badNumber.statusCode).toBe(409)
    expect(JSON.parse(badNumber.body)).toMatchObject({ error: 'invalid-request' })

    const unknownSession = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/comments?sessionId=other&number=1`), unknownSession)
    expect(unknownSession.statusCode).toBe(409)
    expect(JSON.parse(unknownSession.body)).toMatchObject({ error: 'session-unavailable' })
  })
})
