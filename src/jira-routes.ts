import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_JIRA_PATH } from './constants.ts'
import { registerPluginRoute, type PluginRouteIo } from './http.ts'
import { JiraError, type JiraService } from './jira.ts'

const MAX_BODY_BYTES = 8 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The wrapper enforces the byte cap; its plain rejection is translated back
 *  into the JiraError shape the panel already knows how to render. */
async function readJson(io: PluginRouteIo): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await io.body(MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof SyntaxError) throw error
    throw new JiraError('body-too-large', 'The request body is too large.')
  }
  const value = record(body)
  if (value === undefined) throw new JiraError('invalid-request', 'The request body is invalid.')
  return value
}

function string(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new JiraError('invalid-request', `The ${key} field is required.`)
  return value
}

export function registerJiraRoute(ctx: Context, service: JiraService): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'prefix',
    path: CLAUDE_JIRA_PATH,
    methods: ['GET', 'POST'],
    budget: 'git',
    handler: async io => {
      const url = io.url
      try {
        if (url.pathname === `${CLAUDE_JIRA_PATH}/status`) {
          if (io.method !== 'GET') return { status: 405, value: { error: 'method not allowed' } }
          return { status: 200, value: await service.status() }
        }
        if (url.pathname === `${CLAUDE_JIRA_PATH}/connect`) {
          if (io.method !== 'POST') return { status: 405, value: { error: 'method not allowed' } }
          const input = await readJson(io)
          return {
            status: 200,
            value: await service.connect({
              siteUrl: string(input, 'siteUrl'),
              email: string(input, 'email'),
              apiToken: string(input, 'apiToken'),
            }),
          }
        }
        if (url.pathname === `${CLAUDE_JIRA_PATH}/disconnect`) {
          if (io.method !== 'POST') return { status: 405, value: { error: 'method not allowed' } }
          await service.disconnect()
          return { status: 200, value: { connected: false } }
        }
        if (url.pathname === `${CLAUDE_JIRA_PATH}/assign`) {
          if (io.method !== 'POST') return { status: 405, value: { error: 'method not allowed' } }
          const input = await readJson(io)
          await service.assignToMe(string(input, 'key'))
          return { status: 200, value: { assigned: true } }
        }
        if (url.pathname === `${CLAUDE_JIRA_PATH}/search`) {
          if (io.method !== 'GET') return { status: 405, value: { error: 'method not allowed' } }
          return { status: 200, value: { tickets: await service.search(url.searchParams.get('query') ?? '') } }
        }
        return { status: 404, value: { error: 'not found' } }
      } catch (error) {
        if (error instanceof JiraError) return { status: 409, value: { error: error.code, message: error.message } }
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 500, value: { error: 'jira-unavailable', message: 'Jira is unavailable.' } }
      }
    },
  })
}
