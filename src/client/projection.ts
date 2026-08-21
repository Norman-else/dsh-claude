import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent, ClaudeContextUsageEvent, ClaudeTasksEvent } from '../events.ts'
import type { ClaudeCommandView } from '../command-bridge.ts'
import { CLAUDE_PROJECTION_PATH } from '../constants.ts'

export interface ClaudeClientProjection {
  readonly schemaVersion: 1
  readonly revision: number
  readonly owned: boolean
  readonly commands: readonly ClaudeCommandView[]
  readonly activities: readonly ClaudeActivityEvent[]
  readonly contextUsage?: ClaudeContextUsageEvent
  readonly tasks?: ClaudeTasksEvent
}

export const EMPTY_CLAUDE_PROJECTION: ClaudeClientProjection = {
  schemaVersion: 1,
  revision: 0,
  owned: false,
  commands: [],
  activities: [],
}

const POLL_INTERVAL_MS = 2_000
const MAX_ACTIVITIES = 10_000
const MAX_COMMANDS = 2_000

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Validate the public route envelope before publishing it to UI components. */
export function parseClaudeClientProjection(value: unknown): ClaudeClientProjection {
  const input = record(value)
  if (input === undefined
    || input.schemaVersion !== 1
    || !nonNegativeInteger(input.revision)
    || typeof input.owned !== 'boolean'
    || !Array.isArray(input.commands)
    || input.commands.length > MAX_COMMANDS
    || !Array.isArray(input.activities)
    || input.activities.length > MAX_ACTIVITIES) {
    throw new Error('invalid Claude sidecar projection')
  }
  for (const item of input.commands) {
    const command = record(item)
    if (command === undefined
      || typeof command.publicName !== 'string'
      || typeof command.claudeName !== 'string'
      || typeof command.description !== 'string'
      || (command.hint !== undefined && typeof command.hint !== 'string')
      || typeof command.prefixed !== 'boolean') throw new Error('invalid Claude command projection')
  }
  for (const item of input.activities) {
    const activity = record(item)
    if (activity === undefined
      || !nonNegativeInteger(activity.turn)
      || !nonNegativeInteger(activity.step)
      || !nonNegativeInteger(activity.ordinal)
      || typeof activity.kind !== 'string') throw new Error('invalid Claude sidecar activity')
  }
  if (input.contextUsage !== undefined && record(input.contextUsage) === undefined) {
    throw new Error('invalid Claude context projection')
  }
  const tasks = input.tasks === undefined ? undefined : record(input.tasks)
  if (tasks !== undefined && !Array.isArray(tasks.tasks)) throw new Error('invalid Claude tasks projection')
  return input as unknown as ClaudeClientProjection
}

export interface ClaudeProjectionSource extends HostObservable<ClaudeClientProjection> {
  dispose(): void
}

/** Create one lazy source: active subscribers trigger an immediate load and bounded polling. */
export function createClaudeProjectionSource(
  sessionId: string,
  fetchProjection: typeof fetch = fetch,
  pollIntervalMs = POLL_INTERVAL_MS,
): ClaudeProjectionSource {
  let snapshot = EMPTY_CLAUDE_PROJECTION
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let disposed = false
  const listeners = new Set<() => void>()

  const schedule = (): void => {
    if (disposed || listeners.size === 0) return
    timer = setTimeout(() => { void refresh() }, pollIntervalMs)
  }
  const refresh = async (): Promise<void> => {
    if (disposed || listeners.size === 0) return
    controller?.abort()
    controller = new AbortController()
    try {
      const response = await fetchProjection(`${CLAUDE_PROJECTION_PATH}/${encodeURIComponent(sessionId)}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Claude projection request failed (${response.status})`)
      const next = parseClaudeClientProjection(await response.json())
      const commandCatalogChanged = JSON.stringify(next.commands) !== JSON.stringify(snapshot.commands)
      if (next.revision !== snapshot.revision || next.owned !== snapshot.owned || commandCatalogChanged) {
        snapshot = next
        for (const listener of [...listeners]) listener()
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && snapshot !== EMPTY_CLAUDE_PROJECTION) {
        snapshot = EMPTY_CLAUDE_PROJECTION
        for (const listener of [...listeners]) listener()
      }
    } finally {
      controller = undefined
      schedule()
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      const wasIdle = listeners.size === 0
      listeners.add(listener)
      if (wasIdle) void refresh()
      return () => {
        listeners.delete(listener)
        if (listeners.size !== 0) return
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        controller?.abort()
        controller = undefined
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      controller?.abort()
      controller = undefined
    },
  }
}

export class ClaudeProjectionStore {
  readonly #sources = new Map<string, ClaudeProjectionSource>()

  source(sessionId: string): ClaudeProjectionSource {
    let source = this.#sources.get(sessionId)
    if (source === undefined) {
      source = createClaudeProjectionSource(sessionId)
      this.#sources.set(sessionId, source)
    }
    return source
  }

  dispose(): void {
    for (const source of this.#sources.values()) source.dispose()
    this.#sources.clear()
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Plugin-owned sidecar projection for the rendered session. */
    useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  }

  interface SessionMaybeStandardProps {
    useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection> | undefined
  }
}
