import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_JIRA_PATH } from './constants.ts'
import { json, trustedRequest } from './http.ts'
import { JiraError, type JiraService } from './jira.ts'

const MAX_BODY_BYTES = 8 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new JiraError('body-too-large', 'The request body is too large.')
    chunks.push(buffer)
  }
  const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  if (value === undefined) throw new JiraError('invalid-request', 'The request body is invalid.')
  return value
}

function string(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new JiraError('invalid-request', `The ${key} field is required.`)
  return value
}

export function registerJiraRoute(ctx: Context, service: JiraService): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CLAUDE_JIRA_PATH,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        if (url.pathname === `${CLAUDE_JIRA_PATH}/status`) {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          return json(res, 200, await service.status())
        }
        if (url.pathname === `${CLAUDE_JIRA_PATH}/connect`) {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(req)
          return json(res, 200, await service.connect({
            siteUrl: string(input, 'siteUrl'),
            email: string(input, 'email'),
            apiToken: string(input, 'apiToken'),
          }))
        }
        if (url.pathname === `${CLAUDE_JIRA_PATH}/disconnect`) {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          await service.disconnect()
          return json(res, 200, { connected: false })
        }
        if (url.pathname === `${CLAUDE_JIRA_PATH}/assign`) {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          const input = await readJson(req)
          await service.assignToMe(string(input, 'key'))
          return json(res, 200, { assigned: true })
        }
        if (url.pathname === `${CLAUDE_JIRA_PATH}/search`) {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          return json(res, 200, { tickets: await service.search(url.searchParams.get('query') ?? '') })
        }
        return json(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof JiraError) return json(res, 409, { error: error.code, message: error.message })
        if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid-json' })
        return json(res, 500, { error: 'jira-unavailable', message: 'Jira is unavailable.' })
      }
    },
  }), 'dsh-claude: jira route')
}
