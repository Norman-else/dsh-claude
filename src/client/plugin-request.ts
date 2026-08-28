/** Deadlines for the plugin's own HTTP routes.
 *
 *  A browser opens at most six connections to one origin, and a request that
 *  never settles holds one of them for the life of the page. A handful of
 *  those and every plugin route — the projection stream included — stops
 *  answering, which reads as the whole plugin freezing until the Host is
 *  restarted. So no plain request is allowed to wait forever: the deadline is
 *  generous enough that a slow answer still arrives, and short enough that a
 *  wedged one gives its connection back.
 *
 *  Streaming routes (projection, ask, repository setup) are legitimately
 *  long-lived and carry their own cancellation instead. */

/** Reads: the route answers from cache or a short-timeout Git call. */
export const PLUGIN_READ_TIMEOUT_MS = 30_000
/** Writes: the route may chain several remote Git/gh calls of its own. */
export const PLUGIN_ACTION_TIMEOUT_MS = 180_000

/** Combine a caller's cancellation with this deadline. */
export function pluginRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}
