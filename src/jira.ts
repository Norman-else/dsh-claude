import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESULTS = 20
const MAX_QUERY_CHARS = 200
const MAX_STORE_BYTES = 64 * 1024

export interface JiraConnectionInput {
  readonly siteUrl: string
  readonly email: string
  readonly apiToken: string
}

interface JiraStore extends JiraConnectionInput {
  readonly displayName?: string
}

/** Connection state exposed to the browser; never carries the token. */
export interface JiraStatus {
  readonly connected: boolean
  readonly siteUrl?: string
  readonly email?: string
  readonly displayName?: string
}

export interface JiraTicket {
  readonly key: string
  readonly summary: string
  readonly url: string
  readonly status?: string
  readonly type?: string
}

export interface JiraServiceOptions {
  readonly storePath?: string
  readonly fetch?: typeof fetch
}

export class JiraError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'JiraError'
    this.code = code
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Jira Cloud sites are origins; Data Center may carry a context path. */
export function normalizeSiteUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new JiraError('invalid-site', 'The Jira site URL is invalid.')
  }
  if (url.protocol !== 'https:') throw new JiraError('invalid-site', 'The Jira site URL must use https.')
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

export function ticketKeyOf(query: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/u.exec(query.trim())
  return match === null ? undefined : `${match[1]!.toUpperCase()}-${match[2]!}`
}

export function buildJql(query: string): string {
  const trimmed = query.trim().slice(0, MAX_QUERY_CHARS)
  if (trimmed.length === 0) return 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
  const key = ticketKeyOf(trimmed)
  if (key !== undefined) return `key = "${key}"`
  const escaped = trimmed.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `text ~ "${escaped}*" ORDER BY updated DESC`
}

export function parseTickets(value: unknown, siteUrl: string): readonly JiraTicket[] {
  const issues = record(value)?.issues
  if (!Array.isArray(issues)) return []
  const tickets: JiraTicket[] = []
  for (const item of issues) {
    const issue = record(item)
    const fields = record(issue?.fields)
    if (issue === undefined || typeof issue.key !== 'string' || fields === undefined) continue
    const status = record(fields.status)?.name
    const type = record(fields.issuetype)?.name
    tickets.push({
      key: issue.key,
      summary: typeof fields.summary === 'string' ? fields.summary.slice(0, 256) : '',
      url: `${siteUrl}/browse/${issue.key}`,
      ...(typeof status === 'string' ? { status } : {}),
      ...(typeof type === 'string' ? { type } : {}),
    })
    if (tickets.length >= MAX_RESULTS) break
  }
  return tickets
}

function statusOf(store: JiraStore | undefined): JiraStatus {
  if (store === undefined) return { connected: false }
  return {
    connected: true,
    siteUrl: store.siteUrl,
    email: store.email,
    ...(store.displayName === undefined ? {} : { displayName: store.displayName }),
  }
}

/** Jira Cloud access through the user's API token (Basic auth). */
export class JiraService {
  readonly #storePath: string
  readonly #fetch: typeof fetch

  constructor(options: JiraServiceOptions = {}) {
    this.#storePath = options.storePath ?? dshHomePath('plugins', 'dsh-claude', 'jira.json')
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async status(): Promise<JiraStatus> {
    return statusOf(await this.#read())
  }

  async connect(input: JiraConnectionInput): Promise<JiraStatus> {
    const siteUrl = normalizeSiteUrl(input.siteUrl)
    const email = input.email.trim()
    const apiToken = input.apiToken.trim()
    if (email.length === 0 || email.length > 320 || apiToken.length === 0 || apiToken.length > 4_096) {
      throw new JiraError('invalid-credentials', 'An account email and API token are required.')
    }
    const connection = { siteUrl, email, apiToken }
    const myself = record(await this.#json(connection, '/rest/api/3/myself'))
    const displayName = typeof myself?.displayName === 'string' ? myself.displayName : undefined
    const store: JiraStore = { ...connection, ...(displayName === undefined ? {} : { displayName }) }
    await this.#write(store)
    return statusOf(store)
  }

  async disconnect(): Promise<void> {
    await rm(this.#storePath, { force: true })
  }

  async search(query: string): Promise<readonly JiraTicket[]> {
    const store = await this.#read()
    if (store === undefined) throw new JiraError('not-connected', 'Connect Jira in Settings first.')
    const params = new URLSearchParams({ jql: buildJql(query), maxResults: String(MAX_RESULTS), fields: 'summary,status,issuetype' })
    let body: unknown
    try {
      body = await this.#json(store, `/rest/api/3/search/jql?${params.toString()}`)
    } catch (error) {
      // Older deployments only serve the classic search endpoint.
      if (!(error instanceof JiraError && error.code === 'not-found')) throw error
      body = await this.#json(store, `/rest/api/3/search?${params.toString()}`)
    }
    return parseTickets(body, store.siteUrl)
  }

  async #json(connection: JiraConnectionInput, path: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.#fetch(`${connection.siteUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`${connection.email}:${connection.apiToken}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new JiraError('unreachable', 'The Jira site could not be reached.')
    }
    if (response.status === 401 || response.status === 403) throw new JiraError('unauthorized', 'Jira rejected the credentials.')
    if (response.status === 404) throw new JiraError('not-found', 'The Jira endpoint was not found.')
    if (!response.ok) throw new JiraError('jira-failed', `Jira responded with HTTP ${response.status}.`)
    try {
      return await response.json() as unknown
    } catch {
      throw new JiraError('jira-failed', 'Jira returned an invalid response.')
    }
  }

  async #read(): Promise<JiraStore | undefined> {
    let text: string
    try {
      text = await readFile(this.#storePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (Buffer.byteLength(text) > MAX_STORE_BYTES) return undefined
    const input = record(JSON.parse(text))
    if (input === undefined || typeof input.siteUrl !== 'string' || typeof input.email !== 'string' || typeof input.apiToken !== 'string') return undefined
    return {
      siteUrl: input.siteUrl,
      email: input.email,
      apiToken: input.apiToken,
      ...(typeof input.displayName === 'string' ? { displayName: input.displayName } : {}),
    }
  }

  async #write(store: JiraStore): Promise<void> {
    await mkdir(dirname(this.#storePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.#storePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      await rename(temporary, this.#storePath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
