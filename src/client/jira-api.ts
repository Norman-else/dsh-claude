import { CLAUDE_JIRA_PATH } from '../constants.ts'
import type { JiraStatus, JiraTicket } from '../jira.ts'
import { PLUGIN_READ_TIMEOUT_MS, pluginRequestSignal } from './plugin-request.ts'

export type { JiraStatus, JiraTicket } from '../jira.ts'

export class JiraClientError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'JiraClientError'
    if (code !== undefined) this.code = code
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${CLAUDE_JIRA_PATH}${path}`, {
    credentials: 'same-origin',
    signal: pluginRequestSignal(PLUGIN_READ_TIMEOUT_MS),
    ...init,
  })
  const body = record(await response.json() as unknown)
  if (!response.ok) {
    throw new JiraClientError(
      typeof body?.message === 'string' ? body.message : 'Jira is unavailable.',
      typeof body?.error === 'string' ? body.error : undefined,
    )
  }
  if (body === undefined) throw new JiraClientError('Invalid Jira response.')
  return body
}

function status(body: Record<string, unknown>): JiraStatus {
  if (typeof body.connected !== 'boolean') throw new JiraClientError('Invalid Jira status response.')
  return body as unknown as JiraStatus
}

export async function loadJiraStatus(signal?: AbortSignal): Promise<JiraStatus> {
  return status(await call('/status', { method: 'GET', headers: { accept: 'application/json' }, ...(signal === undefined ? {} : { signal }) }))
}

export async function connectJira(input: { siteUrl: string; email: string; apiToken: string }): Promise<JiraStatus> {
  return status(await call('/connect', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

export async function disconnectJira(): Promise<void> {
  await call('/disconnect', { method: 'POST', headers: { accept: 'application/json' } })
}

export async function searchJiraTickets(query: string, signal?: AbortSignal): Promise<readonly JiraTicket[]> {
  const body = await call(`/search?query=${encodeURIComponent(query)}`, { method: 'GET', headers: { accept: 'application/json' }, ...(signal === undefined ? {} : { signal }) })
  if (!Array.isArray(body.tickets)) throw new JiraClientError('Invalid Jira search response.')
  const tickets: JiraTicket[] = []
  for (const item of body.tickets) {
    const ticket = record(item)
    if (ticket === undefined || typeof ticket.key !== 'string' || typeof ticket.summary !== 'string' || typeof ticket.url !== 'string') continue
    tickets.push(ticket as unknown as JiraTicket)
  }
  return tickets
}

export async function assignJiraTicket(key: string): Promise<void> {
  await call('/assign', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })
}

/** Draft seeded into the composer when a session starts from a ticket. */
export function ticketPrompt(ticket: JiraTicket): string {
  return `Work on Jira ticket ${ticket.key}: ${ticket.summary}\n${ticket.url}\n\nRead the ticket, implement what it asks for, and reference ${ticket.key} in the commit and pull request.`
}

/** Appended to a user-written draft so the session still knows its ticket. */
export function ticketContext(ticket: JiraTicket): string {
  return `This task is for Jira ticket ${ticket.key}: ${ticket.summary}\n${ticket.url}\n\nRead the ticket for full context and reference ${ticket.key} in the commit and pull request.`
}
