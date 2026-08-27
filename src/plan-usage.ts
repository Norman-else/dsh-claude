/** Claude.ai plan rate-limit windows behind the CLI's `/usage` panel.
 *
 *  The Agent SDK exposes them through an experimental query method whose name
 *  advertises its own instability, so every read is guarded: a missing method,
 *  a shape change, or an API-key session all degrade to `available: false`
 *  instead of breaking the settings page. */

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
