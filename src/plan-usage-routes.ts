import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_USAGE_PATH } from './constants.ts'
import { redactText } from './events.ts'
import { json, trustedRequest } from './http.ts'
import { latestPlanUsage, recordPlanUsage, type PlanUsageReport } from './plan-usage.ts'

const EMPTY: PlanUsageReport = { available: false, windows: [], fetchedAt: 0 }

function safeMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), 1_000)
}

/** Plan usage: GET serves the value the metadata bridge last cached (free —
 *  it rides an already-running session), POST reads fresh numbers from a
 *  throwaway probe process so a refresh never depends on, or disturbs, a live
 *  Claude session. */
export function registerPlanUsageRoute(
  ctx: Context,
  probe: (fetchedAt: number) => Promise<PlanUsageReport>,
  now: () => number = Date.now,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_USAGE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method === 'GET') return json(res, 200, latestPlanUsage() ?? EMPTY)
      try {
        const report = await probe(now())
        recordPlanUsage(report)
        json(res, 200, report)
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    },
  }), 'dsh-claude: plan usage route')
}
