/** Only GitHub's own image hosts; the browser loads these directly, so a URL
 *  the API did not vouch for must never become an outbound request. */
export function githubAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) return undefined
  try {
    const url = new URL(value)
    const allowed = url.hostname === 'github.com' || url.hostname === 'githubusercontent.com' || url.hostname.endsWith('.githubusercontent.com')
    return url.protocol === 'https:' && allowed ? url.href : undefined
  } catch {
    return undefined
  }
}
