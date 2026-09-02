import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent, ClaudeContextUsageEvent, ClaudeTasksEvent } from '../events.ts'
import type { ClaudeCommandView } from '../command-bridge.ts'
import type { RepositoryStatus } from '../repository-status.ts'
import type { ReviewComment } from '../review-comments.ts'
import { CLAUDE_PROJECTION_PATH, isClaudeRenderMode } from '../constants.ts'
import { MAX_MULTIPLEX_SESSIONS } from '../plugin-budget.ts'
import { MAX_REWIND_RANGES, type ClaudeRewindRange } from '../rewind.ts'
import { pluginProjectionStream } from './plugin-transport.ts'

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
  /** Surface seq spans a rewind dropped; the chat suppresses their rows. */
  readonly rewind?: { readonly ranges: readonly ClaudeRewindRange[] }
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
/** Floor between carrier reopens forced by a desync. A carrier that is losing
 *  lines must not be answered with a reconnect per lost line. */
const RESYNC_COOLDOWN_MS = 5_000
/** Wait for the subscribed set to stop moving before reopening the carrier:
 *  mounting a session list changes it once per row. */
const SUBSCRIPTION_SETTLE_MS = 250
const NDJSON_SEPARATOR = String.fromCharCode(10)
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
  if (input.rewind !== undefined) {
    const ranges = record(input.rewind)?.ranges
    if (!Array.isArray(ranges) || ranges.length > MAX_REWIND_RANGES) throw new Error('invalid Claude rewind projection')
    for (const item of ranges) {
      const range = record(item)
      if (range === undefined || !nonNegativeInteger(range.start) || !nonNegativeInteger(range.end)) {
        throw new Error('invalid Claude rewind projection')
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
  /** Apply one NDJSON line the store demultiplexed to this session. */
  feed(line: string): void
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

/** One session's reducer over the shared carrier's lines.
 *
 *  A source opens nothing. It used to hold a stream of its own, which made the
 *  plugin's connection count a function of how many sessions existed;
 *  {@link ClaudeProjectionStore} now owns the single carrier and feeds each
 *  session's lines here. `onDemand` reports whether anyone is watching, which
 *  is what the store uses to decide which sessions the carrier subscribes to. */
export function createClaudeProjectionSource(
  sessionId: string,
  onDemand: (active: boolean) => void = () => {},
  onDesync: (kind: string, detail: string) => void = () => {},
): ClaudeProjectionSource {
  let snapshot = EMPTY_CLAUDE_PROJECTION
  let revision = 0
  /** Last carrier line this reducer applied, by the server's count. Undefined
   *  until a snapshot states where the stream stands. */
  let seq: number | undefined
  let owned = false
  let commands: readonly ClaudeCommandView[] = []
  let contextUsage: ClaudeContextUsageEvent | undefined
  let tasks: ClaudeTasksEvent | undefined
  let repository: RepositoryStatus | undefined
  let reviewComments: readonly ReviewComment[] | undefined
  let rewind: ClaudeClientProjection['rewind']
  const byStep = new Map<string, ClaudeActivityEvent[]>()
  const stepOrder: { turn: number; step: number; key: string }[] = []
  /** Streaming prose still being revealed: full arrived text plus shown chars. */
  const reveal = new Map<string, { full: ClaudeActivityEvent; shown: number }>()
  let disposed = false
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
      ...(rewind === undefined ? {} : { rewind }),
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
    const { turn, step, ordinal, append, text, renderer } = event
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
    const template = pending?.full ?? existing ?? {
      turn,
      step,
      ordinal,
      kind: 'text' as const,
      phase: 'updated' as const,
      // The stamp travels with the prose so a natively drawn step is not also
      // drawn by the plugin transcript while it streams.
      ...(isClaudeRenderMode(renderer) ? { renderer } : {}),
    }
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

  /** This reducer is behind the server and cannot catch up on its own: only a
   *  fresh snapshot can. Reported as well as acted on, because a silent
   *  self-heal hides how often the carrier is losing lines.
   *
   *  Numbering stops until that snapshot arrives and states it again; every
   *  line in between would only be measured against a count already known to
   *  be wrong. */
  const desync = (kind: string, detail: string): void => {
    seq = undefined
    onDesync(kind, `${sessionId}: ${detail}`)
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
    // A checkpoint carries no change: it only restates where the stream ended,
    // which is the sole way a turn's LAST lost delta ever becomes visible.
    if (event.type === 'checkpoint') {
      if (nonNegativeInteger(event.seq) && seq !== undefined && event.seq !== seq) {
        desync('projection-gap', `checkpoint at ${event.seq}, applied ${seq}`)
      }
      return
    }
    // A snapshot restates the whole projection rather than extending it, so it
    // is never measured against the count -- it IS the new count.
    if (event.type !== 'snapshot' && nonNegativeInteger(event.seq) && seq !== undefined && event.seq !== seq + 1) {
      desync('projection-gap', `expected ${seq + 1}, received ${event.seq}`)
    }
    try {
      switch (event.type) {
        case 'snapshot': {
          const next = parseClaudeClientProjection(event)
          seq = nonNegativeInteger(event.seq) ? event.seq : undefined
          revision = next.revision
          owned = next.owned
          commands = next.commands
          contextUsage = next.contextUsage
          tasks = next.tasks
          repository = next.repository
          reviewComments = next.reviewComments
          rewind = next.rewind
          reset(next.activities)
          break
        }
        case 'text':
          if (!applyText(event)) {
            // Either the line is unusable, or it appends to prose this reducer
            // does not have -- and a base it never received is the same hole a
            // dropped delta leaves. Before the first snapshot there is no count
            // to be behind, and an early append is just arrival order.
            if (seq !== undefined) desync('projection-delta-rejected', 'text not applied')
            return
          }
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
      // Keeping the last verified state visible is right -- mounted UI must not
      // disappear over one bad line -- but staying silent about it is what let a
      // dropped tool result read as a tool that never finished.
      desync('projection-delta-rejected', `rejected ${event.type}`)
      return
    }
    if (nonNegativeInteger(event.seq)) seq = event.seq
    schedulePublish()
  }

  return {
    getSnapshot: () => snapshot,
    feed: applyLine,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      // EVERY subscriber renews the interest, not just the first one. The lane
      // set is an LRU, and a standing background watcher holds a listener on
      // sessions nobody is looking at -- so a first-subscriber-only signal let
      // the session the user then opened stay at the cold end and lose its
      // lane, which is a transcript that renders nothing.
      onDemand(true)
      return () => {
        listeners.delete(listener)
        if (listeners.size !== 0) return
        cancelFrame()
        onDemand(false)
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      cancelFrame()
      onDemand(false)
    },
  }
}

/** Whether two lane sets carry the same sessions. Order is the LRU's business,
 *  not the carrier's: the server reads `sessions=` as a set. */
function sameLanes(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length) return false
  const held = new Set(before)
  return after.every(sessionId => held.has(sessionId))
}

/**
 * Every session's projection over ONE connection.
 *
 * The plugin used to open an NDJSON stream per session, so its share of the
 * browser's small per-origin connection budget grew with the number of Claude
 * sessions — and the overview panel subscribes one per LISTED session, not per
 * open one. Past a handful of sessions the plugin's own settings panel could no
 * longer get a connection at all, which is the failure this class exists to
 * make impossible: the carrier is one connection whatever the session count.
 *
 * `source(sessionId)` keeps its shape, so consumers are unaware of any of this.
 */
export class ClaudeProjectionStore {
  readonly #sources = new Map<string, ClaudeProjectionSource>()
  /** Sessions with at least one live subscriber, newest interest last. */
  readonly #wanted = new Set<string>()
  readonly #open: (path: string, cancel: AbortSignal) => Promise<ReadableStreamDefaultReader<Uint8Array>>
  readonly #retryDelayMs: number
  readonly #settleMs: number
  readonly #report: (kind: string, detail: string) => void
  readonly #resyncCooldownMs: number
  #resyncedAt = 0
  /** Whether the carrier is in a run of failures. One report per outage: the
   *  retry loop runs every couple of seconds and a beacon per attempt would
   *  be the plugin reporting its own noise. */
  #carrierFailing = false
  #controller: AbortController | undefined
  #settle: ReturnType<typeof setTimeout> | undefined
  #running = false
  #disposed = false

  constructor(options: {
    open?: (path: string, cancel: AbortSignal) => Promise<ReadableStreamDefaultReader<Uint8Array>>
    retryDelayMs?: number
    settleMs?: number
    /** Where a desync is reported; the DSH log by way of client diagnostics. */
    report?: (kind: string, detail: string) => void
    resyncCooldownMs?: number
  } = {}) {
    this.#open = options.open ?? ((path, cancel) => pluginProjectionStream(path, cancel))
    this.#retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
    this.#settleMs = options.settleMs ?? SUBSCRIPTION_SETTLE_MS
    this.#report = options.report ?? (() => {})
    this.#resyncCooldownMs = options.resyncCooldownMs ?? RESYNC_COOLDOWN_MS
  }

  source(sessionId: string): ClaudeProjectionSource {
    let source = this.#sources.get(sessionId)
    if (source === undefined) {
      source = createClaudeProjectionSource(
        sessionId,
        active => { this.#demand(sessionId, active) },
        (kind, detail) => { this.#resync(kind, detail) },
      )
      this.#sources.set(sessionId, source)
    }
    return source
  }

  /** Reopen the carrier so every lane is restated from a fresh snapshot.
   *
   *  One session noticed the hole, but the carrier is shared and a dropped
   *  line is a property of the carrier, so the others are suspect too --
   *  reopening restates all of them for the price of the one reconnect. */
  #resync(kind: string, detail: string): void {
    if (this.#disposed) return
    this.#report(kind, detail)
    const now = Date.now()
    if (now - this.#resyncedAt < this.#resyncCooldownMs) return
    this.#resyncedAt = now
    this.#reopen()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#settle !== undefined) clearTimeout(this.#settle)
    this.#settle = undefined
    this.#controller?.abort()
    this.#controller = undefined
    for (const source of this.#sources.values()) source.dispose()
    this.#sources.clear()
    this.#wanted.clear()
  }

  /** Note interest and reopen the carrier once the set stops moving. Mounting
   *  a session list would otherwise reopen it once per row. */
  #demand(sessionId: string, active: boolean): void {
    if (this.#disposed) return
    const before = this.#lanes()
    if (active) {
      // Re-inserting moves it to the end, so the LRU drops the coldest lane.
      this.#wanted.delete(sessionId)
      this.#wanted.add(sessionId)
    } else if (!this.#wanted.delete(sessionId)) return
    // Renewed interest in a session that already holds a lane changes nothing
    // the carrier can see; reopening for it would restate every lane on every
    // session the user opens.
    if (sameLanes(before, this.#lanes())) return
    if (this.#settle !== undefined) clearTimeout(this.#settle)
    const timer = setTimeout(() => {
      this.#settle = undefined
      this.#reopen()
    }, this.#settleMs)
    ;(timer as { unref?: () => void }).unref?.()
    this.#settle = timer
  }

  #lanes(): readonly string[] {
    const wanted = [...this.#wanted]
    // Newest interest wins a lane; an evicted session keeps its last snapshot.
    return wanted.slice(Math.max(0, wanted.length - MAX_MULTIPLEX_SESSIONS))
  }

  #reopen(): void {
    this.#controller?.abort()
    this.#controller = undefined
    if (this.#disposed || this.#wanted.size === 0) return
    void this.#run()
  }

  async #run(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (!this.#disposed && this.#wanted.size > 0) {
        const controller = new AbortController()
        this.#controller = controller
        const lanes = this.#lanes()
        // Set when a reopen interrupts this carrier, to tell a deliberate
        // swap apart from a connection that failed on its own.
        let superseded = false
        try {
          const reader = await this.#open(
            `${CLAUDE_PROJECTION_PATH}/multi?sessions=${lanes.map(encodeURIComponent).join(',')}`,
            controller.signal,
          )
          this.#carrierFailing = false
          // A reopen has to interrupt the read, not wait for the next byte:
          // the carrier can sit silent for a long time between turns, and a
          // resync that lands after the next delta is no resync at all.
          const stop = (): void => {
            superseded = true
            void reader.cancel().catch(() => undefined)
          }
          controller.signal.addEventListener('abort', stop, { once: true })
          const decoder = new TextDecoder()
          let buffer = ''
          while (!controller.signal.aborted) {
            const chunk = await reader.read()
            buffer += decoder.decode(chunk.value, { stream: !chunk.done })
            const lines = buffer.split(NDJSON_SEPARATOR)
            buffer = lines.pop() ?? ''
            for (const line of lines) this.#dispatch(line)
            if (chunk.done) break
          }
          controller.signal.removeEventListener('abort', stop)
          await reader.cancel().catch(() => undefined)
        } catch (error) {
          if (isAbort(error)) {
            // A deliberate reopen; the loop re-reads the current lane set.
            if (this.#controller !== controller) continue
            return
          }
          // Everything else used to be swallowed here, and the loop went on
          // retrying every couple of seconds with nothing on screen and
          // nothing in the log to say why the transcript had stopped.
          if (!this.#carrierFailing) {
            this.#carrierFailing = true
            this.#report('projection-carrier-unavailable', error instanceof Error ? error.message : String(error))
          }
        } finally {
          if (this.#controller === controller) this.#controller = undefined
        }
        if (this.#disposed || this.#wanted.size === 0) return
        // A deliberate reopen is not a failed connection: re-read the lane set
        // now rather than making the user wait out the retry backoff.
        if (superseded) continue
        await delay(this.#retryDelayMs)
      }
    } finally {
      this.#running = false
    }
  }

  /** Route one carrier line to the session that owns it. A line for a session
   *  nobody is watching any more is dropped rather than reviving its lane. */
  #dispatch(line: string): void {
    if (line.length === 0) return
    let session: unknown
    try {
      session = (JSON.parse(line) as { session?: unknown }).session
    } catch {
      return
    }
    if (typeof session !== 'string') return
    this.#sources.get(session)?.feed(line)
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
