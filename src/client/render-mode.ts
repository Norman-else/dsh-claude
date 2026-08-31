import { CLAUDE_GLOBAL_SETTINGS_PATH, DEFAULT_CLAUDE_RENDER_MODE, isClaudeRenderMode, type ClaudeRenderMode } from '../constants.ts'

/** Where the last known renderer choice is cached for the next Client boot.
 *
 *  The Client must decide which conversation nodes to register while `apply()`
 *  runs: a Definition registered after the Conversation has already assembled
 *  the log does not retroactively materialize its nodes. The settings route is
 *  async, so the boot decision reads this mirror and the fetch only refreshes
 *  it for the next reload — which is why the setting declares a restart
 *  effect rather than pretending to switch live. */
export const CLAUDE_RENDER_MODE_STORAGE_KEY = 'dsh-claude:render-mode'

const REQUEST_TIMEOUT_MS = 20_000

/** The renderer this Client boot draws Claude output with. Anything unreadable
 *  — no Web Storage, a private-mode throw, a stale or hand-edited value —
 *  keeps the plugin-owned transcript, which is what every install had before
 *  the setting existed. */
export function claudeRenderMode(): ClaudeRenderMode {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_CLAUDE_RENDER_MODE
    const cached = localStorage.getItem(CLAUDE_RENDER_MODE_STORAGE_KEY)
    return isClaudeRenderMode(cached) ? cached : DEFAULT_CLAUDE_RENDER_MODE
  } catch {
    return DEFAULT_CLAUDE_RENDER_MODE
  }
}

export function cacheClaudeRenderMode(mode: ClaudeRenderMode): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(CLAUDE_RENDER_MODE_STORAGE_KEY, mode)
  } catch {
    // A Client that cannot cache simply re-reads the route next boot.
  }
}

/** Read the renderer from the trusted settings route and cache it for the next
 *  boot. Resolves to the mode the Host reports, or undefined when the route is
 *  unreachable or answers with a shape this build does not understand. */
export async function refreshClaudeRenderMode(): Promise<ClaudeRenderMode | undefined> {
  let payload: unknown
  try {
    const response = await fetch(CLAUDE_GLOBAL_SETTINGS_PATH, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    payload = await response.json() as unknown
  } catch {
    return undefined
  }
  const settings = (payload as { settings?: unknown } | null)?.settings
  if (!Array.isArray(settings)) return undefined
  for (const setting of settings) {
    if (typeof setting !== 'object' || setting === null) continue
    const entry = setting as { key?: unknown; value?: unknown }
    if (entry.key !== 'renderer' || !isClaudeRenderMode(entry.value)) continue
    cacheClaudeRenderMode(entry.value)
    return entry.value
  }
  return undefined
}
