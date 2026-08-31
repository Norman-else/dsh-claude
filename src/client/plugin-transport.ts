/**
 * The plugin's only door to the network.
 *
 * Every request the Client makes goes through here, and the shape of the
 * public functions is the point. There is no `signal` property, no `headers`,
 * no `RequestInit` and no millisecond number in any parameter: a caller cannot
 * hand this module an options object whose later spread silently overwrites
 * the deadline sitting above it. That is not a hypothetical — it is exactly
 * how four call sites lost their deadlines while looking completely ordinary,
 * because `exactOptionalPropertyTypes` forbids writing `signal: undefined` and
 * the spread idiom is what people reach for instead. `cancel` is positional
 * here, so `undefined` is simply passable and the idiom has nothing to do.
 *
 * The second seal is arithmetic. The browser shares a small fixed connection
 * budget between this plugin and the Host, and the plugin used to spend it
 * proportionally to how many Claude sessions existed. Here every request takes
 * a permit from a fixed pool first, so more call sites and more sessions
 * cannot become more sockets — a saturated plugin queues, and says `starved`
 * within `QUEUE_WAIT_BUDGET_MS` instead of dying silently at its full budget.
 *
 * Lane caps guarantee a read always has somewhere to go: the projection
 * carrier holds a reserved permit, and `write + stream` can occupy at most two
 * of the remaining three. The panel that diagnoses a saturated pool is
 * therefore the one request that cannot be starved by it.
 */
import {
  CLIENT_GRACE_MS,
  PLUGIN_GLOBAL_PERMITS,
  PLUGIN_LANE_CAPS,
  QUEUE_WAIT_BUDGET_MS,
  ROUTE_BUDGET_MS,
  clientBudgetMs,
  type PluginLane,
  type RouteBudget,
} from '../plugin-budget.ts'

export type { RouteBudget }

/** Why a plugin request failed, as a value the UI can branch on. */
export type PluginFailure =
  /** Never got a permit: the plugin's own budget is saturated. */
  | 'starved'
  /** Dispatched, and the budget elapsed. */
  | 'timeout'
  /** The route answered, with a non-2xx status. */
  | 'http'
  /** The route answered with a body this build does not understand. */
  | 'shape'
  /** The caller went away. */
  | 'cancelled'
  /** 404: the Host is running an older server bundle than this Client. */
  | 'route-missing'

export class PluginRequestError extends Error {
  readonly reason: PluginFailure
  readonly status?: number
  readonly code?: string

  constructor(reason: PluginFailure, message: string, status?: number, code?: string) {
    super(message)
    this.name = 'PluginRequestError'
    this.reason = reason
    if (status !== undefined) this.status = status
    if (code !== undefined) this.code = code
  }
}

/** Note the absence of `signal`, `headers` and `init`: nothing here can be
 *  spread over a deadline, because no deadline is ever passed in. */
export interface PluginReadOptions {
  query?: Readonly<Record<string, string>>
  /** In-flight coalescing key; defaults to method, path and query. */
  key?: string
}

export interface PluginWriteOptions extends PluginReadOptions {
  method?: 'POST' | 'PATCH' | 'DELETE'
  json?: unknown
}

interface Waiter {
  lane: PluginLane
  admit: () => void
  reject: (error: PluginRequestError) => void
  timer: ReturnType<typeof setTimeout>
}

let send: typeof fetch = (...args) => fetch(...args)
let held = 0
const laneHeld: Record<PluginLane, number> = { read: 0, write: 0, stream: 0 }
let projectionHeld = false
let queue: Waiter[] = []
const inFlight = new Map<string, Promise<unknown>>()

/** The projection carrier owns a permit of its own, outside the lane caps, so
 *  the transcript stream and the panels never compete for the same slot. */
function laneHasRoom(lane: PluginLane): boolean {
  return held < PLUGIN_GLOBAL_PERMITS && laneHeld[lane] < PLUGIN_LANE_CAPS[lane]
}

function pump(): void {
  for (let index = 0; index < queue.length; index += 1) {
    const waiter = queue[index]
    if (waiter === undefined || !laneHasRoom(waiter.lane)) continue
    queue.splice(index, 1)
    index -= 1
    clearTimeout(waiter.timer)
    held += 1
    laneHeld[waiter.lane] += 1
    waiter.admit()
  }
}

function release(lane: PluginLane): void {
  held -= 1
  laneHeld[lane] -= 1
  pump()
}

function acquire(lane: PluginLane): Promise<() => void> {
  let released = false
  const releaseOnce = (): void => {
    if (released) return
    released = true
    release(lane)
  }
  if (laneHasRoom(lane)) {
    held += 1
    laneHeld[lane] += 1
    return Promise.resolve(releaseOnce)
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      lane,
      admit: () => resolve(releaseOnce),
      reject,
      timer: setTimeout(() => {
        queue = queue.filter(item => item !== waiter)
        reject(new PluginRequestError('starved', 'The plugin is holding every connection it is allowed to open.'))
      }, QUEUE_WAIT_BUDGET_MS),
    }
    queue.push(waiter)
  })
}

function withQuery(path: string, query: Readonly<Record<string, string>> | undefined): string {
  if (query === undefined) return path
  const params = new URLSearchParams(query)
  const encoded = params.toString()
  return encoded.length === 0 ? path : `${path}?${encoded}`
}

function failureOf(error: unknown, cancel: AbortSignal | undefined): PluginRequestError {
  if (error instanceof PluginRequestError) return error
  if (cancel?.aborted === true) return new PluginRequestError('cancelled', 'The caller cancelled the request.')
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new PluginRequestError('timeout', 'The plugin route did not answer inside its budget.')
  }
  return new PluginRequestError('http', error instanceof Error ? error.message : String(error))
}

async function decode<T>(response: Response): Promise<T> {
  let payload: unknown
  try {
    payload = await response.json() as unknown
  } catch {
    if (response.ok) throw new PluginRequestError('shape', 'The plugin route answered with a body this build cannot read.')
    throw new PluginRequestError('http', `HTTP ${response.status}`, response.status)
  }
  if (response.ok) return payload as T
  if (response.status === 404) {
    throw new PluginRequestError('route-missing', 'The Host is running an older plugin build without this route.', 404)
  }
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined
  const message = typeof record?.message === 'string'
    ? record.message
    : typeof record?.error === 'string' ? record.error : `HTTP ${response.status}`
  const code = typeof record?.error === 'string' ? record.error : undefined
  throw new PluginRequestError('http', message, response.status, code)
}

async function dispatch<T>(
  lane: PluginLane,
  method: string,
  path: string,
  budget: RouteBudget,
  cancel: AbortSignal | undefined,
  options: PluginWriteOptions | undefined,
): Promise<T> {
  const url = withQuery(path, options?.query)
  const key = options?.key ?? `${method} ${url}`
  const existing = inFlight.get(key)
  if (existing !== undefined) return await existing as T
  const run = (async (): Promise<T> => {
    const free = await acquire(lane)
    try {
      const timeout = AbortSignal.timeout(clientBudgetMs(budget))
      const signal = cancel === undefined ? timeout : AbortSignal.any([cancel, timeout])
      const response = await send(url, {
        method,
        credentials: 'same-origin',
        signal,
        headers: options?.json === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        ...(options?.json === undefined ? {} : { body: JSON.stringify(options.json) }),
      })
      return await decode<T>(response)
    } catch (error) {
      throw failureOf(error, cancel)
    } finally {
      free()
    }
  })()
  inFlight.set(key, run)
  try {
    return await run
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key)
  }
}

/** A bounded read of a plugin route. */
export function pluginRead<T>(
  path: string,
  budget: RouteBudget,
  cancel?: AbortSignal,
  options?: PluginReadOptions,
): Promise<T> {
  return dispatch<T>('read', 'GET', path, budget, cancel, options)
}

/** A bounded write. Writes never coalesce by default: two of them are two
 *  intents, even when their bodies match. */
export function pluginWrite<T>(
  path: string,
  budget: RouteBudget,
  cancel?: AbortSignal,
  options?: PluginWriteOptions,
): Promise<T> {
  const method = options?.method ?? 'POST'
  return dispatch<T>('write', method, path, budget, cancel, {
    ...options,
    key: options?.key ?? `${method} ${withQuery(path, options?.query)} #${nextWriteId()}`,
  })
}

let writeId = 0
function nextWriteId(): number {
  writeId += 1
  return writeId
}

async function openStream(
  lane: PluginLane,
  path: string,
  cancel: AbortSignal,
  options: PluginWriteOptions | undefined,
  reserved: boolean,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const url = withQuery(path, options?.query)
  const free = reserved ? () => { projectionHeld = false } : await acquire(lane)
  try {
    const response = await send(url, {
      method: options?.method ?? 'GET',
      credentials: 'same-origin',
      signal: cancel,
      headers: options?.json === undefined ? { accept: 'application/x-ndjson' } : { accept: 'application/x-ndjson', 'content-type': 'application/json' },
      ...(options?.json === undefined ? {} : { body: JSON.stringify(options.json) }),
    })
    if (!response.ok || response.body === null) {
      free()
      if (response.status === 404) {
        throw new PluginRequestError('route-missing', 'The Host is running an older plugin build without this route.', 404)
      }
      throw new PluginRequestError('http', `HTTP ${response.status}`, response.status)
    }
    // The permit is held for the life of the response, not the life of this
    // call: the reader releases it when the caller's signal aborts.
    cancel.addEventListener('abort', free, { once: true })
    return response.body.getReader()
  } catch (error) {
    free()
    throw failureOf(error, cancel)
  }
}

/** A long-lived NDJSON response. No deadline — it is meant to stay open — but
 *  it takes a counted permit for its whole life, which is the bound that
 *  matters. */
export function pluginNdjson(
  path: string,
  cancel: AbortSignal,
  options?: PluginWriteOptions,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  return openStream('stream', path, cancel, options, false)
}

/** The reserved projection carrier: exactly one live connection, ever,
 *  whatever the session count. */
export function pluginProjectionStream(
  path: string,
  cancel: AbortSignal,
  options?: PluginReadOptions,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  if (projectionHeld) {
    return Promise.reject(new PluginRequestError('starved', 'The projection carrier is already open.'))
  }
  projectionHeld = true
  return openStream('stream', path, cancel, options, true)
}

/** Fire-and-forget diagnostics. Dropped rather than queued when saturated:
 *  the channel that reports the plugin's own failures must never be the
 *  traffic that causes them. */
export function pluginBeacon(path: string, body: unknown): void {
  if (!laneHasRoom('write')) return
  void pluginWrite(path, 'fast', undefined, { json: body }).catch(() => undefined)
}

/** Test seam. The transport holds module-level state by design. */
export function __setPluginFetch(value: typeof fetch): void {
  send = value
}

export function __resetPluginTransport(): void {
  send = (...args) => fetch(...args)
  held = 0
  laneHeld.read = 0
  laneHeld.write = 0
  laneHeld.stream = 0
  projectionHeld = false
  for (const waiter of queue) clearTimeout(waiter.timer)
  queue = []
  inFlight.clear()
  writeId = 0
}

/** Exposed for the budget-contract test, which asserts the client always
 *  waits longer than the server route it is calling. */
export const PLUGIN_BUDGETS = { ROUTE_BUDGET_MS, CLIENT_GRACE_MS } as const
