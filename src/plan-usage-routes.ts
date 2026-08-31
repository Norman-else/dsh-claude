import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_USAGE_PATH } from './constants.ts'
import { redactText } from './events.ts'
import { registerPluginRoute } from './http.ts'
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
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_USAGE_PATH,
    methods: ['GET', 'POST'],
    // The probe spawns a throwaway CLI; the cached GET answers from memory.
    budget: 'git',
    handler: async io => {
      if (io.method === 'GET') return { status: 200, value: latestPlanUsage() ?? EMPTY }
      try {
        const report = await probe(now())
        recordPlanUsage(report)
        return { status: 200, value: report }
      } catch (error) {
        return { status: 500, value: { error: safeMessage(error) } }
      }
    },
  })
}
