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
  parseReviewThreads,
  githubAvatarUrl,
} from '../src/pr-feedback.ts'

function graphqlThreads(nodes: readonly unknown[]): string {
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } })
}

interface Result { readonly stdout?: string; readonly exitCode?: number }

const written: string[] = []

function handle(result: Result, piped: boolean): SubprocessHandle {
  const stdout = result.stdout ?? ''
  return {
    pid: 1,
    stdin: piped ? { end: (chunk: string) => { written.push(chunk) } } as unknown as SubprocessHandle['stdin'] : undefined,
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
  written.length = 0
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
    const result = results.shift()
    if (result === undefined) throw new Error('unexpected command')
    return handle(result, spec.stdio?.stdin === 'pipe')
  })
  return { spawn, resolveExecutable: vi.fn(async (name: string) => `/bin/${name}`) }
}

describe('pull request feedback parsing', () => {
  it('maps review threads with their resolution state, side, and line fallback', () => {
    expect(parseReviewThreads(JSON.parse(graphqlThreads([
      {
        id: 'THREAD_1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 12, diffSide: 'RIGHT',
        comments: { nodes: [
          { databaseId: 1, body: 'Fix this', url: 'https://github.com/x', createdAt: '2026-08-28T17:00:00Z', author: { __typename: 'Bot', login: 'mercoder-dev' } },
          { databaseId: 2, body: 'Done', url: 'https://github.com/x#2', author: { login: 'bob' } },
        ] },
      },
      {
        id: 'THREAD_2', isResolved: true, isOutdated: true, path: 'src/b.ts', line: null, originalLine: 4, diffSide: 'LEFT',
        comments: { nodes: [{ databaseId: 3, body: 'Old code', url: 'https://github.com/y', author: { login: 'bob' } }] },
      },
      // A thread whose comments are all empty carries nothing to show.
      { id: 'THREAD_3', isResolved: false, path: 'src/c.ts', line: 1, diffSide: 'RIGHT', comments: { nodes: [{ databaseId: 4, body: '   ', url: '', author: { login: 'carol' } }] } },
    ])))).toEqual([
      {
        id: 'THREAD_1', path: 'src/a.ts', line: 12, side: 'new', resolved: false, outdated: false,
        comments: [
          // GraphQL names an app account by actor type, not by a `[bot]` suffix.
          { id: 1, path: 'src/a.ts', line: 12, side: 'new', author: 'mercoder-dev', bot: true, body: 'Fix this', url: 'https://github.com/x', createdAt: '2026-08-28T17:00:00Z' },
          // GitHub always sends one; a payload without it simply carries no age.
          { id: 2, path: 'src/a.ts', line: 12, side: 'new', author: 'bob', body: 'Done', url: 'https://github.com/x#2' },
        ],
      },
      {
        id: 'THREAD_2', path: 'src/b.ts', line: 4, side: 'old', resolved: true, outdated: true,
        comments: [{ id: 3, path: 'src/b.ts', line: 4, side: 'old', author: 'bob', body: 'Old code', url: 'https://github.com/y' }],
      },
    ])
  })

  it('keeps an author avatar only when GitHub itself hosts it', () => {
    const [thread] = parseReviewThreads(JSON.parse(graphqlThreads([{
      id: 'THREAD_1', isResolved: false, path: 'src/a.ts', line: 12, diffSide: 'RIGHT',
      comments: { nodes: [{
        databaseId: 1, body: 'Fix this', url: 'https://github.com/x',
        author: { login: 'mercoder-dev[bot]', avatarUrl: 'https://avatars.githubusercontent.com/in/42?v=4' },
      }] },
    }])))
    expect(thread?.comments[0]?.avatarUrl).toBe('https://avatars.githubusercontent.com/in/42?v=4')
    expect(githubAvatarUrl('https://evil.example/pixel.png')).toBeUndefined()
    expect(githubAvatarUrl('http://avatars.githubusercontent.com/u/1')).toBeUndefined()
    expect(githubAvatarUrl(undefined)).toBeUndefined()
    // A comment without one simply carries no avatar.
    const [plain] = parseReviewThreads(JSON.parse(graphqlThreads([{
      id: 'THREAD_2', isResolved: false, path: 'src/b.ts', line: 3, diffSide: 'RIGHT',
      comments: { nodes: [{ databaseId: 2, body: 'x', url: 'https://github.com/y', author: { login: 'alice' } }] },
    }])))
    expect(plain?.comments[0]).not.toHaveProperty('avatarUrl')
  })

  it('returns nothing for a GraphQL payload that carries errors instead of threads', () => {
    expect(parseReviewThreads({ errors: [{ message: 'Could not resolve to a Repository' }] })).toEqual([])
    expect(parseReviewThreads(undefined)).toEqual([])
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
  it('loads review threads through the GraphQL API', async () => {
    const fake = runtime([
      { stdout: 'git@github.com:Mercaso/store.git\n' },
      { stdout: graphqlThreads([{
        id: 'THREAD_1', isResolved: false, path: 'a.ts', line: 2, diffSide: 'RIGHT',
        comments: { nodes: [{ databaseId: 1, body: 'Hi', url: 'https://github.com/x', author: { login: 'alice' } }] },
      }]) },
    ])
    const service = new PullRequestFeedbackService(fake)
    const threads = await service.threads('/repo', 12)
    expect(threads.map(thread => thread.id)).toEqual(['THREAD_1'])
    const argv = fake.spawn.mock.calls[1]?.[0].argv ?? []
    expect(argv.slice(0, 3)).toEqual(['/bin/gh', 'api', 'graphql'])
    // The owner and repository never reach the query text, so a repository named
    // like GraphQL syntax cannot rewrite the query.
    expect(argv).toContain('owner=Mercaso')
    expect(argv).toContain('name=store')
    expect(argv).toContain('number=12')
    expect(argv.join(' ')).toContain('reviewThreads')
  })

  it('reports a GraphQL failure instead of an empty review', async () => {
    const fake = runtime([
      { stdout: 'git@github.com:Mercaso/store.git\n' },
      { stdout: '', exitCode: 1 },
    ])
    await expect(new PullRequestFeedbackService(fake).threads('/repo', 12))
      .rejects.toMatchObject({ code: 'comments-unavailable' })
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

  it('replies to a thread with the body on stdin rather than the command line', async () => {
    const fake = runtime([
      { stdout: 'git@github.com:Mercaso/store.git\n' },
      { stdout: JSON.stringify({ id: 9, body: 'Thanks @alice', html_url: 'https://github.com/x#9', created_at: '2026-08-28T21:00:00Z', user: { login: 'me' } }) },
    ])
    const posted = await new PullRequestFeedbackService(fake).reply('/repo', 12, 3, 'Thanks @alice')

    expect(posted).toMatchObject({ id: 9, author: 'me', body: 'Thanks @alice', createdAt: '2026-08-28T21:00:00Z' })
    expect(fake.spawn.mock.calls[1]?.[0].argv).toEqual([
      '/bin/gh', 'api', '-X', 'POST', 'repos/Mercaso/store/pulls/12/comments/3/replies', '--input', '-',
    ])
    // A comment body is user prose: keeping it off argv keeps it out of the
    // process table and away from shell argument limits.
    expect(written).toEqual([JSON.stringify({ body: 'Thanks @alice' })])
    expect(fake.spawn.mock.calls[1]?.[0].stdio?.stdin).toBe('pipe')
  })

  it('reports a rejected reply instead of pretending it posted', async () => {
    const fake = runtime([
      { stdout: 'git@github.com:Mercaso/store.git\n' },
      { stdout: '', exitCode: 1 },
    ])
    await expect(new PullRequestFeedbackService(fake).reply('/repo', 12, 3, 'Thanks'))
      .rejects.toMatchObject({ code: 'reply-failed' })
  })

  it('resolves and unresolves a thread through the matching mutation', async () => {
    const resolving = runtime([{ stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }) }])
    await expect(new PullRequestFeedbackService(resolving).setResolved('/repo', 'THREAD_1', true)).resolves.toBe(true)
    const resolveArgv = resolving.spawn.mock.calls[0]?.[0].argv ?? []
    expect(resolveArgv.slice(0, 3)).toEqual(['/bin/gh', 'api', 'graphql'])
    expect(resolveArgv).toContain('threadId=THREAD_1')
    expect(resolveArgv.join(' ')).toContain('resolveReviewThread')

    const unresolving = runtime([{ stdout: JSON.stringify({ data: { unresolveReviewThread: { thread: { isResolved: false } } } }) }])
    await expect(new PullRequestFeedbackService(unresolving).setResolved('/repo', 'THREAD_1', false)).resolves.toBe(false)
    expect(unresolving.spawn.mock.calls[0]?.[0].argv?.join(' ')).toContain('unresolveReviewThread')

    const failing = runtime([{ stdout: '', exitCode: 1 }])
    await expect(new PullRequestFeedbackService(failing).setResolved('/repo', 'THREAD_1', true))
      .rejects.toMatchObject({ code: 'resolve-failed' })
  })

  it('suggests mentionable users for the repository', async () => {
    const fake = runtime([
      { stdout: 'git@github.com:Mercaso/store.git\n' },
      { stdout: JSON.stringify({ data: { repository: { mentionableUsers: { nodes: [
        { login: 'alice', avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' },
        { login: 'bob', avatarUrl: 'https://evil.example/pixel.png' },
        { login: '' },
      ] } } } }) },
    ])
    const users = await new PullRequestFeedbackService(fake).mentionables('/repo', 'al')

    expect(users).toEqual([
      { login: 'alice', avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' },
      { login: 'bob' },
    ])
    // `query=` is taken by the GraphQL document itself, so the search term
    // travels as its own variable.
    expect(fake.spawn.mock.calls[1]?.[0].argv).toContain('q=al')
  })

  it('rejects repositories without a GitHub origin remote', async () => {
    const fake = runtime([{ stdout: 'https://gitlab.com/x/y.git\n' }])
    await expect(new PullRequestFeedbackService(fake).threads('/repo', 1))
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

function request(url: string, method = 'GET', body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(stream, {
    method,
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
  it('posts replies and thread resolutions bound to the session cwd', async () => {
    const ctx = context()
    const service = {
      reply: vi.fn(async () => ({ id: 9, path: 'a.ts', line: 2, side: 'new', author: 'me', body: 'ok', url: 'https://github.com/x#9' })),
      setResolved: vi.fn(async () => true),
      mentionables: vi.fn(async () => [{ login: 'alice' }]),
    }
    registerPullRequestFeedbackRoute(ctx, service as unknown as PullRequestFeedbackService, id => id === 'owned' ? '/repo' : undefined)

    const replied = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/reply?sessionId=owned&number=12`, 'POST', { commentId: 3, body: 'ok' }), replied)
    expect(replied.statusCode).toBe(200)
    expect(service.reply).toHaveBeenCalledWith('/repo', 12, 3, 'ok')
    expect(JSON.parse(replied.body)).toMatchObject({ comment: { id: 9 } })

    const resolved = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/resolve?sessionId=owned&number=12`, 'POST', { threadId: 'THREAD_1', resolved: true }), resolved)
    expect(resolved.statusCode).toBe(200)
    expect(service.setResolved).toHaveBeenCalledWith('/repo', 'THREAD_1', true)
    expect(JSON.parse(resolved.body)).toMatchObject({ resolved: true })

    const mentions = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/mentionables?sessionId=owned&number=12&q=al`), mentions)
    expect(mentions.statusCode).toBe(200)
    expect(service.mentionables).toHaveBeenCalledWith('/repo', 'al')

    // A reply with no body never reaches the GitHub CLI.
    const empty = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/reply?sessionId=owned&number=12`, 'POST', { commentId: 3, body: '   ' }), empty)
    expect(empty.statusCode).toBe(409)
    expect(service.reply).toHaveBeenCalledTimes(1)

    // Reads stay reads: the write paths refuse GET, and /comments refuses POST.
    const wrongMethod = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/reply?sessionId=owned&number=12`), wrongMethod)
    expect(wrongMethod.statusCode).toBe(405)
    const postedRead = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/comments?sessionId=owned&number=12`, 'POST', {}), postedRead)
    expect(postedRead.statusCode).toBe(405)
  })

  it('binds comments and checks to the session cwd and validates the number', async () => {
    const ctx = context()
    const service = {
      threads: vi.fn(async () => []),
      failingChecks: vi.fn(async () => []),
    }
    registerPullRequestFeedbackRoute(ctx, service as unknown as PullRequestFeedbackService, id => id === 'owned' ? '/repo' : undefined)

    const ok = response()
    await ctx.handler(request(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/comments?sessionId=owned&number=12`), ok)
    expect(ok.statusCode).toBe(200)
    expect(service.threads).toHaveBeenCalledWith('/repo', 12)
    expect(JSON.parse(ok.body)).toEqual({ threads: [] })

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
