import { CLAUDE_JIRA_PATH } from '../constants.ts'
import type { JiraStatus, JiraTicket } from '../jira.ts'
import { PluginRequestError, pluginRead, pluginWrite } from './plugin-transport.ts'

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

/**
 * Every Jira failure the panels catch is a `JiraClientError`, whatever the
 * transport threw: `ClaudeHeroRepositoryControls` branches on `code` to tell
 * 'not-connected' apart from a real outage, and the settings card renders the
 * message verbatim.
 *
 * The routes answer `{ error, message }`, so `message` is already the sentence
 * to show. A body carrying only a code — a 405, a bad JSON body — used to read
 * 'Jira is unavailable.' rather than leaking the code as prose, and it still
 * does. Transport failures (a starved pool, an elapsed budget, an older Host
 * without the route) carry their own wording and keep it.
 */
function jiraFailure(cause: unknown): JiraClientError {
  if (cause instanceof JiraClientError) return cause
  if (!(cause instanceof PluginRequestError)) {
    return new JiraClientError(cause instanceof Error ? cause.message : String(cause))
  }
  return new JiraClientError(cause.message === cause.code ? 'Jira is unavailable.' : cause.message, cause.code)
}

function payload(value: unknown): Record<string, unknown> {
  const body = record(value)
  if (body === undefined) throw new JiraClientError('Invalid Jira response.')
  return body
}

function status(value: unknown): JiraStatus {
  const body = payload(value)
  if (typeof body.connected !== 'boolean') throw new JiraClientError('Invalid Jira status response.')
  return body as unknown as JiraStatus
}

export async function loadJiraStatus(signal?: AbortSignal): Promise<JiraStatus> {
  try {
    return status(await pluginRead(`${CLAUDE_JIRA_PATH}/status`, 'remote', signal))
  } catch (cause) {
    throw jiraFailure(cause)
  }
}

export async function connectJira(input: { siteUrl: string; email: string; apiToken: string }): Promise<JiraStatus> {
  try {
    return status(await pluginWrite(`${CLAUDE_JIRA_PATH}/connect`, 'remote', undefined, { json: input }))
  } catch (cause) {
    throw jiraFailure(cause)
  }
}

export async function disconnectJira(): Promise<void> {
  try {
    await pluginWrite(`${CLAUDE_JIRA_PATH}/disconnect`, 'remote')
  } catch (cause) {
    throw jiraFailure(cause)
  }
}

export async function searchJiraTickets(query: string, signal?: AbortSignal): Promise<readonly JiraTicket[]> {
  try {
    const body = payload(await pluginRead(`${CLAUDE_JIRA_PATH}/search`, 'remote', signal, { query: { query } }))
    if (!Array.isArray(body.tickets)) throw new JiraClientError('Invalid Jira search response.')
    const tickets: JiraTicket[] = []
    for (const item of body.tickets) {
      const ticket = record(item)
      if (ticket === undefined || typeof ticket.key !== 'string' || typeof ticket.summary !== 'string' || typeof ticket.url !== 'string') continue
      tickets.push(ticket as unknown as JiraTicket)
    }
    return tickets
  } catch (cause) {
    throw jiraFailure(cause)
  }
}

export async function assignJiraTicket(key: string): Promise<void> {
  try {
    await pluginWrite(`${CLAUDE_JIRA_PATH}/assign`, 'remote', undefined, { json: { key } })
  } catch (cause) {
    throw jiraFailure(cause)
  }
}

/** Draft seeded into the composer when a session starts from a ticket. */
export function ticketPrompt(ticket: JiraTicket): string {
  return `Work on Jira ticket ${ticket.key}: ${ticket.summary}\n${ticket.url}\n\nRead the ticket, implement what it asks for, and reference ${ticket.key} in the commit and pull request.`
}

/** Appended to a user-written draft so the session still knows its ticket. */
export function ticketContext(ticket: JiraTicket): string {
  return `This task is for Jira ticket ${ticket.key}: ${ticket.summary}\n${ticket.url}\n\nRead the ticket for full context and reference ${ticket.key} in the commit and pull request.`
}
