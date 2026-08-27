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

/** A session mid-turn rejects metadata control requests. Match on the name
 *  rather than instanceof: a linked plugin can resolve a second copy of the
 *  supervisor module, which would make the class identity check fail. */
function turnBusy(error: unknown): boolean {
  return error instanceof Error && error.name === 'ClaudeTurnBusyError'
}

/** Plan usage: GET serves the value the metadata bridge last cached, POST
 *  forces a fresh read. The settings page is global and owns no session, so a
 *  manual refresh borrows an idle Claude agent to run the SDK request.
 *
 *  A busy or missing session is not an error: the bridge refreshes the cache
 *  on its own whenever a session goes idle, so the answer is the cached
 *  reading plus a note about why it may be stale. */
export function registerPlanUsageRoute(
  ctx: Context,
  supervisor: Pick<ClaudeSupervisor, 'planUsage' | 'snapshots'>,
  claudeAgents: () => readonly Agent[],
  now: () => number = Date.now,
): void {
  // A session with no supervisor entry yet is idle by definition — the request
  // starts its process.
  const idleAgent = (): Agent | undefined => {
    const busy = new Set(supervisor.snapshots().filter(entry => entry.state !== 'idle').map(entry => entry.sessionId))
    return claudeAgents().find(agent => !busy.has(agent.id as string))
  }
  const cached = (message: string): PlanUsageReport => ({ ...(latestPlanUsage() ?? { ...EMPTY, fetchedAt: 0 }), message })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLAUDE_USAGE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method === 'GET') return json(res, 200, latestPlanUsage() ?? { ...EMPTY, fetchedAt: 0 })
      const agent = idleAgent()
      if (agent === undefined) {
        return json(res, 200, cached(claudeAgents().length === 0 ? 'no-session' : 'busy'))
      }
      try {
        const report = normalizePlanUsage(await supervisor.planUsage(agent), now())
        recordPlanUsage(report)
        json(res, 200, report)
      } catch (error) {
        // The chosen session can still start a turn between the pick and the
        // control request; that race reads as busy, not as a failure.
        if (turnBusy(error)) return json(res, 200, cached('busy'))
        json(res, 500, { error: safeMessage(error) })
      }
    },
  }), `dsh-claude: plan usage route`)
}
