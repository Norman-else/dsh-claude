/** Claude.ai plan rate-limit windows behind the CLI's `/usage` panel.
 *
 *  The Agent SDK exposes them through an experimental query method whose name
 *  advertises its own instability, so every read is guarded: a missing method,
 *  a shape change, or an API-key session all degrade to `available: false`
 *  instead of breaking the settings page. */
import { query as claudeQuery, type Options as ClaudeOptions, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** The SDK's own name for the unstable `/usage` control request; it is
 *  documented to change when the API stabilizes, so it lives in one place. */
export const PLAN_USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

/** A throwaway probe should not outlive a wedged control request. */
export const PLAN_USAGE_TIMEOUT_MS = 20_000

/** Invoke the experimental usage control request, or say why we cannot. */
export function readPlanUsageFrom(query: Query): Promise<unknown> {
  const read = (query as Partial<Record<typeof PLAN_USAGE_METHOD, () => Promise<unknown>>>)[PLAN_USAGE_METHOD]
  if (typeof read !== 'function') throw new Error('dsh-claude: this Claude Agent SDK build exposes no plan usage API')
  return read.call(query)
}

/** One utilization window. `label` is only set for server-named model buckets
 *  (e.g. 'Fable'); the fixed windows are translated client-side from `id`. */
export interface PlanUsageWindow {
  readonly id: string
  readonly label?: string
  readonly utilization?: number
  readonly resetsAt?: string
}

export interface PlanUsageReport {
  readonly available: boolean
  readonly subscription?: string
  readonly windows: readonly PlanUsageWindow[]
  readonly fetchedAt: number
  readonly message?: string
}

/** Fixed windows in display order; the SDK omits the ones a plan does not have. */
const FIXED_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Utilization is documented as 0-100; clamp so a server glitch cannot render
 *  a bar wider than its track or a negative width. */
function utilization(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined
}

function resetsAt(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function window(id: string, source: unknown, label?: string): PlanUsageWindow | undefined {
  const entry = record(source)
  if (entry === undefined) return undefined
  const used = utilization(entry.utilization)
  const reset = resetsAt(entry.resets_at)
  if (used === undefined && reset === undefined) return undefined
  return {
    id,
    ...(label === undefined ? {} : { label }),
    ...(used === undefined ? {} : { utilization: used }),
    ...(reset === undefined ? {} : { resetsAt: reset }),
  }
}

/** Project the SDK's `/usage` response onto the windows the settings card shows. */
export function normalizePlanUsage(value: unknown, fetchedAt: number): PlanUsageReport {
  const response = record(value)
  const subscription = typeof response?.subscription_type === 'string' ? response.subscription_type : undefined
  const limits = record(response?.rate_limits)
  if (response?.rate_limits_available !== true || limits === undefined) {
    return {
      available: false,
      ...(subscription === undefined ? {} : { subscription }),
      windows: [],
      fetchedAt,
    }
  }
  const windows = [
    ...FIXED_WINDOWS.map(id => window(id, limits[id])),
    ...(Array.isArray(limits.model_scoped) ? limits.model_scoped : []).map((entry: unknown, index: number) => {
      const name = record(entry)?.display_name
      return window(`model:${typeof name === 'string' ? name : index}`, entry, typeof name === 'string' ? name : undefined)
    }),
  ].filter((entry): entry is PlanUsageWindow => entry !== undefined)
  return {
    available: windows.length > 0,
    ...(subscription === undefined ? {} : { subscription }),
    windows,
    fetchedAt,
  }
}

/** Read plan limits from a throwaway Claude process.
 *
 *  Deliberately NOT routed through the supervisor. Borrowing a session's
 *  process fails outright while that session is mid-turn, and for a session
 *  with no process yet it would resume the whole conversation — and possibly
 *  evict another idle session to make room — just to read three numbers. This
 *  query carries no tools, no permission bridge, and no session binding: it
 *  starts, answers one control request, and is killed. */
export async function probePlanUsage(
  executablePath: string,
  fetchedAt: number,
  factory: (params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeOptions }) => Query = claudeQuery,
): Promise<PlanUsageReport> {
  const lifetime = new AbortController()
  const timer = setTimeout(() => lifetime.abort(), PLAN_USAGE_TIMEOUT_MS)
  timer.unref?.()
  // The SDK ends a query as soon as its prompt stream closes, so hold the
  // stream open and let the abort below tear the process down instead.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<never>(() => {})
  })()
  const query = factory({
    prompt,
    options: {
      cwd: process.cwd(),
      abortController: lifetime,
      ...(executablePath.length === 0 ? {} : { pathToClaudeCodeExecutable: executablePath }),
    },
  })
  try {
    // Control responses only arrive while the message stream is pumped.
    void (async () => { for await (const _ of query) { /* drain */ } })().catch(() => undefined)
    // Aborting tears the probe process down, but the SDK's pending control
    // request is not documented to settle with it — and an unsettled one hangs
    // the route (and the browser connection serving it) for the life of the
    // Host. The deadline is therefore enforced here too, not only on the
    // process.
    const read = await Promise.race([
      readPlanUsageFrom(query),
      new Promise<never>((_resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('dsh-claude: the plan usage request did not answer in time')), PLAN_USAGE_TIMEOUT_MS)
        deadline.unref?.()
      }),
    ])
    return normalizePlanUsage(read, fetchedAt)
  } finally {
    clearTimeout(timer)
    lifetime.abort()
  }
}

// ponytail: a module-level latest-value cache, not a store class. The plugin
// runs one supervisor per Host process and the report is global to the Claude
// account, so per-session state would buy nothing. Promote to a keyed store
// only if the plugin ever serves more than one Claude account at a time.
let latest: PlanUsageReport | undefined

export function recordPlanUsage(report: PlanUsageReport): void {
  latest = report
}

export function latestPlanUsage(): PlanUsageReport | undefined {
  return latest
}

/** Test seam: drop the cached report. */
export function resetPlanUsage(): void {
  latest = undefined
}
