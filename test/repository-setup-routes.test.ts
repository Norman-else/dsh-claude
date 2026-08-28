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
    expect(service.setup).toHaveBeenCalledWith('/repo', 'main', true, 'feature/exact-name', expect.any(Function))
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

  it('refreshes remote branches through a POST because pruning rewrites local refs', async () => {
    const ctx = context()
    const service = {
      refreshBranches: vi.fn(async () => ({
        root: '/repo', current: 'main', dirty: false, branches: ['main'], remoteBranches: ['origin/main', 'origin/psos-5697'],
      })),
    } as unknown as RepositorySetupService
    registerRepositorySetupRoute(ctx, service)

    const refreshed = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_SETUP_PATH}/branches/refresh`, { cwd: '/repo' }), refreshed)
    expect(refreshed.statusCode).toBe(200)
    expect(service.refreshBranches).toHaveBeenCalledWith('/repo')
    expect(JSON.parse(refreshed.body)).toMatchObject({ remoteBranches: ['origin/main', 'origin/psos-5697'] })

    const read = response()
    await ctx.handler(request('GET', `${CLAUDE_REPOSITORY_SETUP_PATH}/branches/refresh?cwd=/repo`), read)
    expect(read.statusCode).toBe(405)
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

describe('repository setup cleanup route', () => {
  it('cleans up merged checkouts through the service', async () => {
    const ctx = context()
    const service = {
      cleanupMerged: vi.fn(async () => ({ mode: 'worktree', root: '/repo', branch: 'PSOS-1' })),
    }
    registerRepositorySetupRoute(ctx, service as unknown as RepositorySetupService)
    const cleanup = response()
    await ctx.handler(request('POST', `${CLAUDE_REPOSITORY_SETUP_PATH}/cleanup`, { path: '/wt', baseBranch: 'main' }), cleanup)
    expect(cleanup.statusCode).toBe(200)
    expect(service.cleanupMerged).toHaveBeenCalledWith('/wt', 'main')
    expect(JSON.parse(cleanup.body)).toMatchObject({ mode: 'worktree', branch: 'PSOS-1' })
  })
})
