/** Compact age of an ISO timestamp, in the shape the panels already use
 *  ("<1h", "4h", "3d", "2mo"). `now` is a parameter so callers that re-render
 *  on a clock — and tests — stay deterministic. */
export function relativeAge(value: string | undefined, now: number = Date.now()): string | undefined {
  if (value === undefined) return undefined
  const elapsedHours = Math.max(0, Math.floor((now - Date.parse(value)) / 3_600_000))
  if (!Number.isFinite(elapsedHours)) return undefined
  if (elapsedHours < 1) return '<1h'
  if (elapsedHours < 24) return `${elapsedHours}h`
  const days = Math.floor(elapsedHours / 24)
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`
}
