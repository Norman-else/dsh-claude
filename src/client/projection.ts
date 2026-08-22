import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent, ClaudeContextUsageEvent, ClaudeTasksEvent } from '../events.ts'
import type { ClaudeCommandView } from '../command-bridge.ts'
import type { RepositoryStatus } from '../repository-status.ts'
import { CLAUDE_PROJECTION_PATH } from '../constants.ts'

export interface ClaudeClientProjection {
  readonly schemaVersion: 1
  readonly revision: number
  readonly owned: boolean
  readonly commands: readonly ClaudeCommandView[]
  readonly activities: readonly ClaudeActivityEvent[]
  readonly contextUsage?: ClaudeContextUsageEvent
  readonly tasks?: ClaudeTasksEvent
  readonly repository?: RepositoryStatus
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
const MAX_REPOSITORY_TEXT_CHARS = 1_024
const MAX_DIFF_CHARS = 256 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function optionalBoundedString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_REPOSITORY_TEXT_CHARS)
}

function validateRepository(value: unknown): value is RepositoryStatus {
  const repository = record(value)
  if (repository === undefined
    || !['ready', 'not-repository', 'unavailable'].includes(String(repository.status))
    || typeof repository.cwd !== 'string'
    || repository.cwd.length > MAX_REPOSITORY_TEXT_CHARS
    || !optionalBoundedString(repository.root)
    || !optionalBoundedString(repository.branch)
    || !optionalBoundedString(repository.remote)
    || (repository.detached !== undefined && typeof repository.detached !== 'boolean')
    || (repository.worktree !== undefined && typeof repository.worktree !== 'boolean')
    || (repository.dirty !== undefined && typeof repository.dirty !== 'boolean')) return false
  if (repository.diff !== undefined) {
    const diff = record(repository.diff)
    if (diff === undefined
      || !nonNegativeInteger(diff.additions)
      || !nonNegativeInteger(diff.deletions)
      || !nonNegativeInteger(diff.files)
      || typeof diff.truncated !== 'boolean'
      || (diff.patch !== undefined && (typeof diff.patch !== 'string' || diff.patch.length > MAX_DIFF_CHARS))) return false
  }
  if (repository.pullRequest === undefined) return true
  const pullRequest = record(repository.pullRequest)
  if (pullRequest === undefined
    || !Number.isSafeInteger(pullRequest.number)
    || Number(pullRequest.number) <= 0
    || typeof pullRequest.title !== 'string'
    || pullRequest.title.length > MAX_REPOSITORY_TEXT_CHARS
    || typeof pullRequest.url !== 'string'
    || pullRequest.url.length > MAX_REPOSITORY_TEXT_CHARS
    || !['open', 'closed', 'merged'].includes(String(pullRequest.state))
    || typeof pullRequest.draft !== 'boolean'
    || !['approved', 'changes-requested', 'review-required', 'none'].includes(String(pullRequest.review))
    || !['passing', 'pending', 'failing', 'none'].includes(String(pullRequest.checks))
    || !optionalBoundedString(pullRequest.mergeState)
    || !optionalBoundedString(pullRequest.author)
    || !optionalBoundedString(pullRequest.baseBranch)
    || (pullRequest.createdAt !== undefined && (typeof pullRequest.createdAt !== 'string' || !Number.isFinite(Date.parse(pullRequest.createdAt))))
    || (pullRequest.mergedAt !== undefined && (typeof pullRequest.mergedAt !== 'string' || !Number.isFinite(Date.parse(pullRequest.mergedAt))))) return false
  try {
    const url = new URL(pullRequest.url)
    return url.protocol === 'https:' && url.hostname === 'github.com'
  } catch {
    return false
  }
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
  if (input.repository !== undefined && !validateRepository(input.repository)) {
    throw new Error('invalid Claude repository projection')
  }
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
      const repositoryChanged = JSON.stringify(next.repository) !== JSON.stringify(snapshot.repository)
      if (next.revision !== snapshot.revision || next.owned !== snapshot.owned || commandCatalogChanged || repositoryChanged) {
        snapshot = next
        for (const listener of [...listeners]) listener()
      }
    } catch (error) {
      // A polling or validation failure is transient. Keep the last verified
      // snapshot visible and retry instead of making mounted UI disappear.
      if (error instanceof DOMException && error.name === 'AbortError') return
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
