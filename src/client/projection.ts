import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent, ClaudeContextUsageEvent, ClaudeTasksEvent } from '../events.ts'
import type { ClaudeCommandView } from '../command-bridge.ts'
import type { RepositoryStatus } from '../repository-status.ts'
import type { ReviewComment } from '../review-comments.ts'
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
  readonly reviewComments?: readonly ReviewComment[]
  /** Client-derived per-step activity slices with stable identities for
   *  untouched steps, so streaming re-renders only the active step. */
  readonly byStep?: ReadonlyMap<string, readonly ClaudeActivityEvent[]>
}

export const EMPTY_CLAUDE_PROJECTION: ClaudeClientProjection = {
  schemaVersion: 1,
  revision: 0,
  owned: false,
  commands: [],
  activities: [],
}

const RETRY_DELAY_MS = 2_000
/** Coalesce stream deltas into at most one React notification per frame. */
const FRAME_MS = 16
/** Typewriter smoothing: drain newly arrived prose over roughly this window,
 *  so the CLI's paragraph-sized deltas read as a continuous character flow. */
const REVEAL_WINDOW_MS = 1_200
/** A burst larger than this (redaction rewrite, reconnect catch-up) shows
 *  instantly instead of animating for a long stretch. */
const MAX_INSTANT_REVEAL = 4_000
const MAX_ACTIVITIES = 10_000
const MAX_COMMANDS = 2_000
const MAX_REPOSITORY_TEXT_CHARS = 1_024
const MAX_DIFF_CHARS = 256 * 1024
const MAX_REVIEW_COMMENTS = 50
const MAX_REVIEW_COMMENT_CHARS = 2_000
const MAX_TRANSCRIPT_CHARS = 64_000

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
    || (repository.dirty !== undefined && typeof repository.dirty !== 'boolean')
    || (repository.upstream !== undefined && typeof repository.upstream !== 'boolean')
    || (repository.ahead !== undefined && !nonNegativeInteger(repository.ahead))
    || (repository.behind !== undefined && !nonNegativeInteger(repository.behind))) return false
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
  if (input.reviewComments !== undefined) {
    if (!Array.isArray(input.reviewComments) || input.reviewComments.length > MAX_REVIEW_COMMENTS) {
      throw new Error('invalid Claude review comment projection')
    }
    for (const item of input.reviewComments) {
      const comment = record(item)
      if (comment === undefined
        || typeof comment.id !== 'string' || comment.id.length === 0 || comment.id.length > 128
        || typeof comment.path !== 'string' || comment.path.length === 0 || comment.path.length > MAX_REPOSITORY_TEXT_CHARS
        || !nonNegativeInteger(comment.line)
        || (comment.side !== 'old' && comment.side !== 'new')
        || typeof comment.text !== 'string' || comment.text.length > MAX_REVIEW_COMMENT_CHARS) {
        throw new Error('invalid Claude review comment projection')
      }
    }
  }
  return input as unknown as ClaudeClientProjection
}

/** Validate one incremental delta payload with the same rules as a snapshot. */
function validateEnvelopeFragment(fragment: Record<string, unknown>): void {
  parseClaudeClientProjection({ schemaVersion: 1, revision: 0, owned: false, commands: [], activities: [], ...fragment })
}

export function stepKeyOf(turn: number, step: number): string {
  return `${turn}:${step}`
}

const EMPTY_ACTIVITIES: readonly ClaudeActivityEvent[] = []

/** Identity-stable per-step slice; untouched steps never re-render while
 *  another step streams. Falls back to filtering for snapshot-only hooks. */
export function selectStepActivities(
  value: ClaudeClientProjection,
  turn: number,
  step: number,
): readonly ClaudeActivityEvent[] {
  const sliced = value.byStep?.get(stepKeyOf(turn, step))
  if (sliced !== undefined) return sliced
  const filtered = value.activities.filter(activity => activity.turn === turn && activity.step === step)
  return filtered.length === 0 ? EMPTY_ACTIVITIES : filtered
}

export interface ClaudeProjectionSource extends HostObservable<ClaudeClientProjection> {
  dispose(): void
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === 'AbortError'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
}

/** Create one lazy source: active subscribers open the Host NDJSON stream, and
 *  a dropped stream reconnects with a fresh snapshot after a bounded delay. */
export function createClaudeProjectionSource(
  sessionId: string,
  fetchProjection: typeof fetch = fetch,
  retryDelayMs = RETRY_DELAY_MS,
): ClaudeProjectionSource {
  let snapshot = EMPTY_CLAUDE_PROJECTION
  let revision = 0
  let owned = false
  let commands: readonly ClaudeCommandView[] = []
  let contextUsage: ClaudeContextUsageEvent | undefined
  let tasks: ClaudeTasksEvent | undefined
  let repository: RepositoryStatus | undefined
  let reviewComments: readonly ReviewComment[] | undefined
  const byStep = new Map<string, ClaudeActivityEvent[]>()
  const stepOrder: { turn: number; step: number; key: string }[] = []
  /** Streaming prose still being revealed: full arrived text plus shown chars. */
  const reveal = new Map<string, { full: ClaudeActivityEvent; shown: number }>()
  let disposed = false
  let running = false
  let controller: AbortController | undefined
  let frame: ReturnType<typeof setTimeout> | number | undefined
  let usedAnimationFrame = false
  const listeners = new Set<() => void>()

  const ensureStep = (turn: number, step: number): ClaudeActivityEvent[] => {
    const key = stepKeyOf(turn, step)
    const existing = byStep.get(key)
    if (existing !== undefined) return existing
    const created: ClaudeActivityEvent[] = []
    byStep.set(key, created)
    const at = stepOrder.findIndex(entry => entry.turn > turn || (entry.turn === turn && entry.step > step))
    stepOrder.splice(at === -1 ? stepOrder.length : at, 0, { turn, step, key })
    return created
  }

  const upsertActivity = (activity: ClaudeActivityEvent): void => {
    const key = stepKeyOf(activity.turn, activity.step)
    // Copy-on-write: only the touched step's slice changes identity.
    const next = ensureStep(activity.turn, activity.step).slice()
    const index = next.findIndex(item => item.ordinal === activity.ordinal)
    if (index === -1) {
      const at = next.findIndex(item => item.ordinal > activity.ordinal)
      next.splice(at === -1 ? next.length : at, 0, activity)
    } else {
      next[index] = activity
    }
    byStep.set(key, next)
  }

  const reset = (activities: readonly ClaudeActivityEvent[]): void => {
    byStep.clear()
    stepOrder.length = 0
    reveal.clear()
    // Snapshot activities arrive globally sorted, so plain pushes stay ordered.
    for (const activity of activities) ensureStep(activity.turn, activity.step).push(activity)
  }

  /** Advance every pending typewriter reveal by one frame's worth of characters.
   *  The per-frame step scales with the backlog so any burst drains in roughly
   *  REVEAL_WINDOW_MS. Returns whether another frame is still needed. */
  const advanceReveals = (): boolean => {
    let remaining = false
    for (const [key, entry] of reveal) {
      const total = entry.full.text?.length ?? 0
      if (entry.shown >= total) {
        reveal.delete(key)
        continue
      }
      const step = Math.max(1, Math.ceil((total - entry.shown) * FRAME_MS / REVEAL_WINDOW_MS))
      entry.shown = Math.min(total, entry.shown + step)
      upsertActivity({ ...entry.full, text: (entry.full.text ?? '').slice(0, entry.shown) })
      if (entry.shown >= total) reveal.delete(key)
      else remaining = true
    }
    return remaining
  }

  const publish = (): void => {
    frame = undefined
    if (disposed) return
    const revealing = advanceReveals()
    const activities: ClaudeActivityEvent[] = []
    for (const entry of stepOrder) {
      const slice = byStep.get(entry.key)
      if (slice !== undefined) for (const item of slice) activities.push(item)
    }
    snapshot = {
      schemaVersion: 1,
      revision,
      owned,
      commands,
      activities,
      ...(contextUsage === undefined ? {} : { contextUsage }),
      ...(tasks === undefined ? {} : { tasks }),
      ...(repository === undefined ? {} : { repository }),
      ...(reviewComments === undefined ? {} : { reviewComments }),
      byStep: new Map(byStep),
    }
    for (const listener of [...listeners]) listener()
    if (revealing) schedulePublish()
  }

  const cancelFrame = (): void => {
    if (frame === undefined) return
    if (usedAnimationFrame) {
      (globalThis as { cancelAnimationFrame?: (handle: number) => void }).cancelAnimationFrame?.(frame as number)
    } else {
      clearTimeout(frame as ReturnType<typeof setTimeout>)
    }
    frame = undefined
  }

  const schedulePublish = (): void => {
    if (disposed || frame !== undefined || listeners.size === 0) return
    const raf = (globalThis as { requestAnimationFrame?: (callback: () => void) => number }).requestAnimationFrame
    if (typeof raf === 'function') {
      usedAnimationFrame = true
      frame = raf(publish)
    } else {
      usedAnimationFrame = false
      frame = setTimeout(publish, FRAME_MS)
    }
  }

  const applyText = (event: Record<string, unknown>): boolean => {
    const { turn, step, ordinal, append, text } = event
    if (!nonNegativeInteger(turn) || !nonNegativeInteger(step) || !nonNegativeInteger(ordinal)) return false
    if (append !== undefined && (typeof append !== 'string' || append.length > MAX_TRANSCRIPT_CHARS)) return false
    if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TRANSCRIPT_CHARS)) return false
    if (append === undefined && text === undefined) return false
    const revealKey = `${turn}:${step}:${ordinal}`
    const slice = byStep.get(stepKeyOf(turn, step))
    const existing = slice?.find(item => item.ordinal === ordinal)
    const pending = reveal.get(revealKey)
    if (existing === undefined && pending === undefined && typeof text !== 'string') {
      // ponytail: an append without its base waits for the next snapshot line
      return false
    }
    // Appends extend the full arrived text, which may be ahead of the
    // currently revealed prefix stored in byStep.
    const baseText = pending?.full.text ?? existing?.text ?? ''
    const fullText = (typeof text === 'string' ? text : `${baseText}${append as string}`).slice(0, MAX_TRANSCRIPT_CHARS)
    const template = pending?.full ?? existing ?? { turn, step, ordinal, kind: 'text' as const, phase: 'updated' as const }
    const full = { ...template, text: fullText }
    const shown = Math.min(pending?.shown ?? existing?.text?.length ?? 0, fullText.length)
    if (fullText.length - shown > MAX_INSTANT_REVEAL) {
      reveal.delete(revealKey)
      upsertActivity(full)
      return true
    }
    reveal.set(revealKey, { full, shown })
    upsertActivity({ ...full, text: fullText.slice(0, shown) })
    return true
  }

  const applyLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      return
    }
    const event = record(value)
    if (event === undefined || typeof event.type !== 'string') return
    try {
      switch (event.type) {
        case 'snapshot': {
          const next = parseClaudeClientProjection(event)
          revision = next.revision
          owned = next.owned
          commands = next.commands
          contextUsage = next.contextUsage
          tasks = next.tasks
          repository = next.repository
          reviewComments = next.reviewComments
          reset(next.activities)
          break
        }
        case 'text':
          if (!applyText(event)) return
          revision += 1
          break
        case 'activity':
          validateEnvelopeFragment({ activities: [event.activity] })
          upsertActivity(event.activity as ClaudeActivityEvent)
          revision += 1
          break
        case 'contextUsage':
          validateEnvelopeFragment({ contextUsage: event.value })
          contextUsage = event.value as ClaudeContextUsageEvent
          revision += 1
          break
        case 'tasks':
          validateEnvelopeFragment({ tasks: event.value })
          tasks = event.value as ClaudeTasksEvent
          revision += 1
          break
        case 'meta':
          validateEnvelopeFragment({
            owned: event.owned,
            commands: event.commands,
            ...(event.repository === undefined ? {} : { repository: event.repository }),
            ...(event.reviewComments === undefined ? {} : { reviewComments: event.reviewComments }),
          })
          owned = event.owned as boolean
          commands = event.commands as readonly ClaudeCommandView[]
          repository = event.repository as RepositoryStatus | undefined
          reviewComments = event.reviewComments as readonly ReviewComment[] | undefined
          revision += 1
          break
        default:
          // ping and unknown line types are ignored
          return
      }
    } catch {
      // A malformed or oversized delta is transient; keep the last verified
      // state visible instead of making mounted UI disappear.
      return
    }
    schedulePublish()
  }

  const run = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      while (!disposed && listeners.size > 0) {
        controller = new AbortController()
        try {
          const response = await fetchProjection(`${CLAUDE_PROJECTION_PATH}/${encodeURIComponent(sessionId)}/stream`, {
            headers: { accept: 'application/x-ndjson' },
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`Claude projection stream failed (${response.status})`)
          if (response.body === null) throw new Error('Claude projection stream is unavailable')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (true) {
            if (disposed || listeners.size === 0) {
              await reader.cancel().catch(() => undefined)
              break
            }
            const chunk = await reader.read()
            buffer += decoder.decode(chunk.value, { stream: !chunk.done })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) applyLine(line)
            if (chunk.done) break
          }
        } catch (error) {
          // Abort is the ordinary unmount path; other failures retry below.
          if (isAbort(error)) return
        } finally {
          controller = undefined
        }
        if (disposed || listeners.size === 0) return
        await delay(retryDelayMs)
      }
    } finally {
      running = false
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      const wasIdle = listeners.size === 0
      listeners.add(listener)
      if (wasIdle) void run()
      return () => {
        listeners.delete(listener)
        if (listeners.size !== 0) return
        controller?.abort()
        controller = undefined
        cancelFrame()
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      controller?.abort()
      controller = undefined
      cancelFrame()
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
