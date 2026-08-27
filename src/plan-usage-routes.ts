import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_USAGE_PATH } from './constants.ts'
import { redactText } from './events.ts'
import { json, trustedRequest } from './http.ts'
import { latestPlanUsage, normalizePlanUsage, recordPlanUsage, type PlanUsageReport } from './plan-usage.ts'
import type { ClaudeSupervisor } from './supervisor.ts'

const EMPTY: Omit<PlanUsageReport, 'fetchedAt'> = { available: false, windows: [] }

function safeMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), 1_000)
}

/** Plan usage: GET serves the value the metadata bridge last cached, POST
 *  forces a fresh read. The settings page is global and owns no session, so a
 *  manual refresh borrows any live Claude agent to run the SDK request. */
export function registerPlanUsageRoute(
  ctx: Context,
  supervisor: Pick<ClaudeSupervisor, 'planUsage'>,
  claudeAgent: () => Agent | undefined,
  now: () => number = Date.now,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_USAGE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method === 'GET') return json(res, 200, latestPlanUsage() ?? { ...EMPTY, fetchedAt: 0 })
      const agent = claudeAgent()
      // No live Claude session means no query to ask; keep whatever the bridge
      // cached and let the client explain why the numbers may be stale.
      if (agent === undefined) {
        const cached = latestPlanUsage()
        return json(res, 200, { ...(cached ?? { ...EMPTY, fetchedAt: 0 }), message: 'no-session' })
      }
      try {
        const report = normalizePlanUsage(await supervisor.planUsage(agent), now())
        recordPlanUsage(report)
        json(res, 200, report)
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    },
  }), `dsh-claude: plan usage route`)
}
