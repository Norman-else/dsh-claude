import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_REPOSITORY_SETUP_PATH } from '../src/constants.ts'
import { registerRepositorySetupRoute } from '../src/repository-setup-routes.ts'
import type { RepositorySetupService } from '../src/repository-setup.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function context(): Context & { handler: Handler } {
  const target = { handler: async () => {} } as { handler: Handler }
  return Object.assign(target, {
    effect: (register: () => unknown) => {
      target.handler = (register() as { handler: Handler }).handler
    },
    webServer: {
      register: (route: { kind: string; path: string; handler: Handler }) => {
        expect(route).toMatchObject({ kind: 'prefix', path: CLAUDE_REPOSITORY_SETUP_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
  Object.assign(stream, {
    method,
    url,
    headers: { host: 'localhost:56454' },
    socket: { remoteAddress: '::1' },
  })
  return stream
}

function response(): ServerResponse & { statusCode: number; body: string; flushed: boolean } {
  return {
    statusCode: 0,
    body: '',
    flushed: false,
    writeHead(status: number) { this.statusCode = status; return this },
    write(body: string) { this.body += body; return true },
    flushHeaders() { this.flushed = true },
    end(body?: string) { if (body !== undefined) this.body += body },
  } as unknown as ServerResponse & { statusCode: number; body: string; flushed: boolean }
}

function events(res: { body: string }): unknown[] {
  return res.body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown)
}

describe('repository setup route', () => {
  it('lists branches, prepares a worktree, and binds its lease', async () => {
    const ctx = context()
    const service = {
      listBranches: vi.fn(async () => ({ root: '/repo', current: 'main', dirty: false, branches: ['main'], remoteBranches: ['origin/main'] })),
      setup: vi.fn(async (_cwd, _branch, _worktree, _branchName, progress) => {
        progress('inspecting')
        progress('fetching')
        return { mode: 'worktree', root: '/repo', path: '/worktree', branch: 'claude/main-x', leaseId: 'lease-1' }
      }),
      bindLease: vi.fn(async () => undefined),
    } as unknown as RepositorySetupService
    registerRepositorySetupRoute(ctx, service)

    const branches = response()
    await ctx.handler(request('GET', `${CLAUDE_REPOSITORY_SETUP_PATH}/branches?cwd=${encodeURIComponent('/repo')}`), branches)
    expect(branches.statusCode).toBe(200)
    expect(service.listBranches).toHaveBeenCalledWith('/repo')

    const setup = response()
    await ctx.handler(request('POST', CLAUDE_REPOSITORY_SETUP_PATH, {
      cwd: '/repo', branch: 'main', worktree: true, branchName: 'feature/exact-name',
    }), setup)
    expect(setup.statusCode).toBe(200)
    expect(setup.flushed).toBe(true)
    expect(service.setup).toHaveBeenCalledWith('/repo', 'main', true, 'feature/exact-name', expect.any(Function), undefined)
    expect(events(setup)).toEqual([
      { type: 'progress', stage: 'inspecting' },
      { type: 'progress', stage: 'fetching' },
      { type: 'complete', result: { mode: 'worktree', root: '/repo', path: '/worktree', branch: 'claude/main-x', leaseId: 'lease-1' } },
    ])

    const bind = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_SETUP_PATH}/bind`, { leaseId: 'lease-1', sessionId: 'session-1' }), bind)
    expect(bind.statusCode).toBe(200)
    expect(service.bindLease).toHaveBeenCalledWith('lease-1', 'session-1')
  })

  it('streams bounded repository setup errors without leaking implementation details', async () => {
    const ctx = context()
    const service = {
      setup: vi.fn(async (_cwd, _branch, _worktree, _branchName, progress) => {
        progress('inspecting')
        throw new Error('raw git stderr')
      }),
    } as unknown as RepositorySetupService
    registerRepositorySetupRoute(ctx, service)

    const setup = response()
    await ctx.handler(request('POST', CLAUDE_REPOSITORY_SETUP_PATH, {
      cwd: '/repo', branch: 'main', worktree: true,
    }), setup)

    expect(setup.statusCode).toBe(200)
    expect(events(setup)).toEqual([
      { type: 'progress', stage: 'inspecting' },
      { type: 'error', code: 'repository-setup-unavailable', message: 'Repository setup is unavailable.' },
    ])
    expect(setup.body).not.toContain('raw git stderr')
  })

  it('rejects cross-origin and malformed requests', async () => {
    const ctx = context()
    registerRepositorySetupRoute(ctx, {} as RepositorySetupService)
    const forbiddenRequest = request('GET', `${CLAUDE_REPOSITORY_SETUP_PATH}/branches?cwd=/repo`)
    Object.assign(forbiddenRequest, { headers: { host: 'attacker.example', origin: 'https://attacker.example' } })
    const forbidden = response()
    await ctx.handler(forbiddenRequest, forbidden)
    expect(forbidden.statusCode).toBe(403)

    const malformed = response()
    await ctx.handler(request('POST', CLAUDE_REPOSITORY_SETUP_PATH, { cwd: '/repo', branch: 'main' }), malformed)
    expect(malformed.statusCode).toBe(409)
  })
})

describe('repository setup issue and cleanup routes', () => {
  it('lists issues, forwards issue seeds into setup, and cleans up merged checkouts', async () => {
    const ctx = context()
    const service = {
      listIssues: vi.fn(async () => [{ number: 3, title: 'Bug', url: 'https://github.com/o/r/issues/3' }]),
      cleanupMerged: vi.fn(async () => ({ mode: 'worktree', root: '/repo', branch: 'claude/issue-3-bug' })),
      setup: vi.fn(async (_cwd: string, _branch: string, _worktree: boolean, _name: string | undefined, _progress: unknown, issue: unknown) => ({
        mode: 'worktree', root: '/repo', path: '/wt', branch: `claude/issue-${String((issue as { number: number }).number)}-bug`, leaseId: 'lease',
      })),
    }
    registerRepositorySetupRoute(ctx, service as unknown as RepositorySetupService)

    const issues = response()
    await ctx.handler(request('GET', `${CLAUDE_REPOSITORY_SETUP_PATH}/issues?cwd=${encodeURIComponent('/repo')}`), issues)
    expect(issues.statusCode).toBe(200)
    expect(JSON.parse(issues.body)).toEqual({ issues: [{ number: 3, title: 'Bug', url: 'https://github.com/o/r/issues/3' }] })
    expect(service.listIssues).toHaveBeenCalledWith('/repo')

    const setup = response()
    await ctx.handler(request('POST', CLAUDE_REPOSITORY_SETUP_PATH, { cwd: '/repo', branch: 'main', worktree: true, issue: { number: 3, title: 'Bug' } }), setup)
    expect(service.setup.mock.calls[0]?.[5]).toEqual({ number: 3, title: 'Bug' })
    expect(setup.body).toContain('claude/issue-3-bug')

    const badIssue = response()
    await ctx.handler(request('POST', CLAUDE_REPOSITORY_SETUP_PATH, { cwd: '/repo', branch: 'main', worktree: true, issue: { number: 'x' } }), badIssue)
    expect(badIssue.body).toContain('invalid-request')

    const cleanup = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_SETUP_PATH}/cleanup`, { path: '/wt', baseBranch: 'main' }), cleanup)
    expect(cleanup.statusCode).toBe(200)
    expect(service.cleanupMerged).toHaveBeenCalledWith('/wt', 'main')
    expect(JSON.parse(cleanup.body)).toMatchObject({ mode: 'worktree', branch: 'claude/issue-3-bug' })
  })
})
