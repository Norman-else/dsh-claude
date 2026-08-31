import { CLAUDE_CLIENT_DIAGNOSTICS_PATH } from '../constants.ts'
import { pluginBeacon } from './plugin-transport.ts'

/** Upper bound on reports per page load.
 *
 *  A crashed Slot entry re-renders on every store notification, so the cap is
 *  what keeps one bug from becoming an unbounded Host log. */
export const CLAUDE_DIAGNOSTICS_REPORT_CAP = 40

export interface ClaudeDiagnosticsReport {
  kind: string
  detail: string
}

export interface ClaudeDiagnosticsReporter {
  /** Forward one finding, at most once per distinct kind and detail. */
  report(kind: string, detail: string): void
}

/** A beacon rather than a request: a finding is dropped when the connection
 *  budget is spent, because the channel that reports the plugin's own failures
 *  must never be the traffic that causes them — and must never queue behind
 *  them either. */
function postToHost(report: ClaudeDiagnosticsReport): void {
  pluginBeacon(CLAUDE_CLIENT_DIAGNOSTICS_PATH, report)
}

/** Renderer-side findings reach the Host log through here.
 *
 *  Nothing the renderer throws — a crashed Slot entry included — reaches the
 *  Host log on its own, and the shipped Desktop build opens no DevTools, so a
 *  plugin whose entries all died looks exactly like a healthy one from the
 *  outside. Every Desktop 2.0 breakage in this package was found only by
 *  attaching a debugger to the renderer by hand. */
export function createClaudeDiagnosticsReporter(
  post: (report: ClaudeDiagnosticsReport) => void = postToHost,
): ClaudeDiagnosticsReporter {
  const sent = new Set<string>()
  return {
    report(kind, detail) {
      if (sent.size >= CLAUDE_DIAGNOSTICS_REPORT_CAP) return
      const key = `${kind} ${detail}`
      if (sent.has(key)) return
      sent.add(key)
      // Reporting a failure must never become one.
      try {
        post({ kind, detail })
      } catch {
        // The Host route is best-effort; losing a diagnostic is not a fault.
      }
    },
  }
}
