import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_JIRA_PATH } from '../src/constants.ts'
import { registerJiraRoute } from '../src/jira-routes.ts'
import { JiraService, buildJql, normalizeSiteUrl, parseTickets, ticketKeyOf } from '../src/jira.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function storePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-jira-'))
  roots.push(root)
  return join(root, 'state', 'jira.json')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('Jira query helpers', () => {
  it('normalizes site URLs, detects ticket keys, and builds JQL', () => {
    expect(normalizeSiteUrl('https://team.atlassian.net/')).toBe('https://team.atlassian.net')
    expect(normalizeSiteUrl('https://jira.example.com/jira/')).toBe('https://jira.example.com/jira')
    expect(() => normalizeSiteUrl('http://team.atlassian.net')).toThrow('https')
    expect(ticketKeyOf(' psos-5683 ')).toBe('PSOS-5683')
    expect(ticketKeyOf('login flow')).toBeUndefined()
    expect(buildJql('')).toBe('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC')
    expect(buildJql('PSOS-12')).toBe('key = "PSOS-12"')
    expect(buildJql('say "hi"')).toBe('text ~ "say \\"hi\\"*" ORDER BY updated DESC')
  })

  it('parses search results into tickets with browse links', () => {
    expect(parseTickets({
      issues: [
        { key: 'PSOS-1', fields: { summary: 'Fix login', status: { name: 'In Progress' }, issuetype: { name: 'Bug' } } },
        { key: 'PSOS-2', fields: { summary: 'No status' } },
        { fields: { summary: 'missing key' } },
      ],
    }, 'https://team.atlassian.net')).toEqual([
      { key: 'PSOS-1', summary: 'Fix login', url: 'https://team.atlassian.net/browse/PSOS-1', status: 'In Progress', type: 'Bug' },
      { key: 'PSOS-2', summary: 'No status', url: 'https://team.atlassian.net/browse/PSOS-2' },
    ])
  })
})

describe('Jira service', () => {
  it('connects with an API token, stores it privately, and searches with Basic auth', async () => {
    const path = await storePath()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/myself')) return jsonResponse(200, { displayName: 'Norman', emailAddress: 'n@example.com' })
      if (url.includes('/rest/api/3/search/jql?')) return jsonResponse(200, { issues: [{ key: 'PSOS-7', fields: { summary: 'Ship it' } }] })
      return jsonResponse(404, {})
    })
    const service = new JiraService({ storePath: path, fetch: fetcher as unknown as typeof fetch })
    await expect(service.status()).resolves.toEqual({ connected: false })
    await expect(service.connect({ siteUrl: 'https://team.atlassian.net/', email: 'n@example.com', apiToken: 'secret-token' }))
      .resolves.toEqual({ connected: true, siteUrl: 'https://team.atlassian.net', email: 'n@example.com', displayName: 'Norman' })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://team.atlassian.net/rest/api/3/myself')
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: `Basic ${Buffer.from('n@example.com:secret-token').toString('base64')}` })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ apiToken: 'secret-token' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(service.status()).resolves.not.toHaveProperty('apiToken')

    await expect(service.search('ship')).resolves.toEqual([{ key: 'PSOS-7', summary: 'Ship it', url: 'https://team.atlassian.net/browse/PSOS-7' }])
    const searchUrl = String(fetcher.mock.calls[1]?.[0])
    expect(searchUrl).toContain('/rest/api/3/search/jql?')
    expect(new URL(searchUrl).searchParams.get('jql')).toBe('text ~ "ship*" ORDER BY updated DESC')

    await service.disconnect()
    await expect(service.status()).resolves.toEqual({ connected: false })
    await expect(service.search('x')).rejects.toMatchObject({ code: 'not-connected' })
  })

  it('falls back to the classic search endpoint and surfaces rejected credentials', async () => {
    const path = await storePath()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/myself')) return jsonResponse(200, {})
      if (url.includes('/rest/api/3/search/jql?')) return jsonResponse(404, {})
      if (url.includes('/rest/api/3/search?')) return jsonResponse(200, { issues: [{ key: 'OLD-1', fields: { summary: 'Legacy' } }] })
      return jsonResponse(500, {})
    })
    const service = new JiraService({ storePath: path, fetch: fetcher as unknown as typeof fetch })
    await service.connect({ siteUrl: 'https://jira.example.com', email: 'n@example.com', apiToken: 't' })
    await expect(service.search('OLD-1')).resolves.toEqual([{ key: 'OLD-1', summary: 'Legacy', url: 'https://jira.example.com/browse/OLD-1' }])

    const rejecting = new JiraService({ storePath: await storePath(), fetch: (async () => jsonResponse(401, {})) as unknown as typeof fetch })
    await expect(rejecting.connect({ siteUrl: 'https://team.atlassian.net', email: 'n@example.com', apiToken: 'bad' }))
      .rejects.toMatchObject({ code: 'unauthorized' })
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
        expect(route).toMatchObject({ kind: 'prefix', path: CLAUDE_JIRA_PATH })
        return route
      },
    },
  }) as unknown as Context & { handler: Handler }
}

function request(method: string, url: string, body?: unknown): IncomingMessage {
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

describe('Jira route', () => {
  it('exposes status, connect, search, and disconnect', async () => {
    const ctx = context()
    const service = {
      status: vi.fn(async () => ({ connected: true, siteUrl: 'https://team.atlassian.net', email: 'n@example.com' })),
      connect: vi.fn(async () => ({ connected: true, siteUrl: 'https://team.atlassian.net', email: 'n@example.com' })),
      disconnect: vi.fn(async () => undefined),
      search: vi.fn(async () => [{ key: 'PSOS-1', summary: 'Fix', url: 'https://team.atlassian.net/browse/PSOS-1' }]),
    }
    registerJiraRoute(ctx, service as unknown as JiraService)

    const status = response()
    await ctx.handler(request('GET', `${CLAUDE_JIRA_PATH}/status`), status)
    expect(status.statusCode).toBe(200)
    expect(JSON.parse(status.body)).toMatchObject({ connected: true })

    const connect = response()
    await ctx.handler(request('POST', `${CLAUDE_JIRA_PATH}/connect`, { siteUrl: 'https://team.atlassian.net', email: 'n@example.com', apiToken: 't' }), connect)
    expect(connect.statusCode).toBe(200)
    expect(service.connect).toHaveBeenCalledWith({ siteUrl: 'https://team.atlassian.net', email: 'n@example.com', apiToken: 't' })

    const invalid = response()
    await ctx.handler(request('POST', `${CLAUDE_JIRA_PATH}/connect`, { siteUrl: 'https://team.atlassian.net' }), invalid)
    expect(invalid.statusCode).toBe(409)
    expect(JSON.parse(invalid.body)).toMatchObject({ error: 'invalid-request' })

    const search = response()
    await ctx.handler(request('GET', `${CLAUDE_JIRA_PATH}/search?query=fix`), search)
    expect(search.statusCode).toBe(200)
    expect(service.search).toHaveBeenCalledWith('fix')
    expect(JSON.parse(search.body).tickets).toHaveLength(1)

    const disconnect = response()
    await ctx.handler(request('POST', `${CLAUDE_JIRA_PATH}/disconnect`), disconnect)
    expect(disconnect.statusCode).toBe(200)
    expect(service.disconnect).toHaveBeenCalledOnce()
  })
})
