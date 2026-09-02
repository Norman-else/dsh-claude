import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  latestClaudeContextUsage,
  latestClaudeSessionBinding,
  latestClaudeTasks,
  normalizeActivity,
  normalizeContextUsage,
  normalizeTasksEvent,
  redactText,
  type ClaudeActivityEvent,
  type ClaudeActivityInput,
  type ClaudeContextUsageEvent,
  type ClaudeContextUsageInput,
  type ClaudeSessionBoundEvent,
  type ClaudeTaskInfo,
  type ClaudeTasksEvent,
} from './events.ts'
import { CLAUDE_ACTIVITY_EVENT, SDK_VERSION, type ClaudeRenderMode } from './constants.ts'
import {
  EMPTY_REWIND_STATE,
  MAX_REWIND_ANCHORS,
  MAX_REWIND_RANGES,
  MAX_REWIND_SNAPSHOTS,
  recordRewindAnchor,
  recordRewindSnapshot,
  type ClaudeRewindAnchor,
  type ClaudeRewindRange,
  type ClaudeRewindSnapshot,
  type ClaudeRewindState,
} from './rewind.ts'

const SIDECAR_SCHEMA_VERSION = 1
const MAX_ACTIVITIES = 10_000
/** Trailing window that coalesces per-token transcript persistence into one
 *  atomic disk write; live subscribers are notified synchronously regardless. */
const TEXT_FLUSH_MS = 150

export interface ClaudeSidecarProjection {
  readonly schemaVersion: typeof SIDECAR_SCHEMA_VERSION
  readonly revision: number
  readonly binding?: ClaudeSessionBoundEvent
  readonly activities: readonly ClaudeActivityEvent[]
  readonly contextUsage?: ClaudeContextUsageEvent
  readonly tasks?: ClaudeTasksEvent
  readonly rewind?: ClaudeRewindState
}

/** Change notification published to live subscribers after each accepted write.
 *
 *  `checkpoint` is the one kind that carries no change: it restates where the
 *  stream stands so a reader can notice it is behind. See {@link ClaudeSidecarRepository.checkpoint}. */
export type ClaudeSidecarDelta =
  | { kind: 'text'; turn: number; step: number; ordinal: number; append?: string; text?: string; renderer?: ClaudeRenderMode }
  | { kind: 'activity'; activity: ClaudeActivityEvent }
  | { kind: 'contextUsage'; value: ClaudeContextUsageEvent }
  | { kind: 'tasks'; value: ClaudeTasksEvent }
  | { kind: 'sync' }
  | { kind: 'checkpoint' }

/** One delta as subscribers see it: numbered, so a reader that applies them in
 *  order can tell a missing one from a slow one.
 *
 *  The projection's own `revision` cannot do this job. Streaming prose notifies
 *  subscribers without touching disk (see {@link ClaudeSidecarRepository.appendTranscriptText}),
 *  so revisions and notifications advance on different clocks; this counter
 *  advances once per notification and nothing else reads it. */
export type ClaudeSidecarNotification = ClaudeSidecarDelta & { readonly seq: number }

export interface ClaudeSidecarRepositoryOptions {
  readonly root?: string
  readonly legacyRoot?: string
}

function emptyProjection(): ClaudeSidecarProjection {
  return { schemaVersion: SIDECAR_SCHEMA_VERSION, revision: 0, activities: [] }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function string(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function binding(value: unknown): ClaudeSessionBoundEvent | undefined {
  const input = record(value)
  if (input === undefined
    || !string(input.claudeSessionId, 512)
    || !string(input.sdkVersion, 128)
    || !string(input.cwd, 4_096)
    || (input.cliVersion !== undefined && !string(input.cliVersion, 128))) return undefined
  return {
    claudeSessionId: input.claudeSessionId,
    sdkVersion: input.sdkVersion,
    cwd: input.cwd,
    ...(input.cliVersion === undefined ? {} : { cliVersion: input.cliVersion }),
  }
}

const ACTIVITY_KINDS = new Set(['text', 'status', 'compaction', 'thinking', 'tool-call', 'tool-result', 'permission', 'question', 'subagent', 'usage', 'warning', 'error'])
const ACTIVITY_PHASES = new Set(['started', 'updated', 'completed', 'denied', 'failed'])

function activity(value: unknown): ClaudeActivityEvent | undefined {
  const input = record(value)
  if (input === undefined
    || !finiteInteger(input.turn)
    || !finiteInteger(input.step)
    || !finiteInteger(input.ordinal)
    || typeof input.kind !== 'string'
    || !ACTIVITY_KINDS.has(input.kind)
    || (input.phase !== undefined && (typeof input.phase !== 'string' || !ACTIVITY_PHASES.has(input.phase)))) return undefined
  return normalizeActivity(input as unknown as ClaudeActivityEvent)
}

function contextUsage(value: unknown): ClaudeContextUsageEvent | undefined {
  const input = record(value)
  if (input === undefined || !Array.isArray(input.categories)) return undefined
  return normalizeContextUsage(input as unknown as ClaudeContextUsageInput)
}

function rewind(value: unknown): ClaudeRewindState | undefined {
  const input = record(value)
  if (input === undefined
    || !Array.isArray(input.ranges) || input.ranges.length > MAX_REWIND_RANGES
    || !Array.isArray(input.anchors) || input.anchors.length > MAX_REWIND_ANCHORS) return undefined
  const ranges: ClaudeRewindRange[] = []
  for (const item of input.ranges) {
    const range = record(item)
    if (range === undefined || !finiteInteger(range.start) || !finiteInteger(range.end) || range.end < range.start) return undefined
    ranges.push({ start: range.start, end: range.end })
  }
  const anchors: ClaudeRewindAnchor[] = []
  for (const item of input.anchors) {
    const anchor = record(item)
    if (anchor === undefined || !finiteInteger(anchor.turn) || !string(anchor.uuid, 128)) return undefined
    anchors.push({ turn: anchor.turn, uuid: anchor.uuid })
  }
  // Documents written before working-tree snapshots existed carry no list;
  // they read as a session that simply has no tree to restore.
  const snapshots: ClaudeRewindSnapshot[] = []
  if (input.snapshots !== undefined) {
    if (!Array.isArray(input.snapshots) || input.snapshots.length > MAX_REWIND_SNAPSHOTS) return undefined
    for (const item of input.snapshots) {
      const snapshot = record(item)
      if (snapshot === undefined || !finiteInteger(snapshot.turn) || !string(snapshot.tree, 64)) return undefined
      snapshots.push({ turn: snapshot.turn, tree: snapshot.tree })
    }
  }
  const pending = record(input.pending)
  if (input.pending !== undefined && pending === undefined) return undefined
  if (pending === undefined) return { ranges, anchors, snapshots }
  if (pending.fresh === true) return { ranges, anchors, snapshots, pending: { fresh: true } }
  if (!string(pending.resumeAt, 128)) return undefined
  return { ranges, anchors, snapshots, pending: { resumeAt: pending.resumeAt } }
}

function tasks(value: unknown): ClaudeTasksEvent | undefined {
  const input = record(value)
  if (input === undefined || !Array.isArray(input.tasks)) return undefined
  return normalizeTasksEvent(input.tasks as ClaudeTaskInfo[])
}

export function parseClaudeSidecar(value: unknown): ClaudeSidecarProjection {
  const input = record(value)
  if (input === undefined
    || input.schemaVersion !== SIDECAR_SCHEMA_VERSION
    || !finiteInteger(input.revision)
    || !Array.isArray(input.activities)
    || input.activities.length > MAX_ACTIVITIES) {
    throw new Error('dsh-claude: invalid sidecar document')
  }
  const activities = input.activities.map(activity)
  if (activities.some(item => item === undefined)) throw new Error('dsh-claude: invalid sidecar activity')
  const parsedBinding = input.binding === undefined ? undefined : binding(input.binding)
  const parsedUsage = input.contextUsage === undefined ? undefined : contextUsage(input.contextUsage)
  const parsedTasks = input.tasks === undefined ? undefined : tasks(input.tasks)
  const parsedRewind = input.rewind === undefined ? undefined : rewind(input.rewind)
  if ((input.binding !== undefined && parsedBinding === undefined)
    || (input.contextUsage !== undefined && parsedUsage === undefined)
    || (input.tasks !== undefined && parsedTasks === undefined)
    || (input.rewind !== undefined && parsedRewind === undefined)) {
    throw new Error('dsh-claude: invalid sidecar projection')
  }
  return {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    revision: input.revision,
    activities: activities as ClaudeActivityEvent[],
    ...(parsedBinding === undefined ? {} : { binding: parsedBinding }),
    ...(parsedUsage === undefined ? {} : { contextUsage: parsedUsage }),
    ...(parsedTasks === undefined ? {} : { tasks: parsedTasks }),
    ...(parsedRewind === undefined ? {} : { rewind: parsedRewind }),
  }
}

function compareActivity(left: ClaudeActivityEvent, right: ClaudeActivityEvent): number {
  return left.turn - right.turn || left.step - right.step || left.ordinal - right.ordinal
}

function activityKey(value: ClaudeActivityEvent): string {
  return `${value.turn}:${value.step}:${value.ordinal}`
}

function mergeActivities(
  existing: readonly ClaudeActivityEvent[],
  additions: readonly ClaudeActivityEvent[],
): ClaudeActivityEvent[] {
  const merged = new Map(existing.map(item => [activityKey(item), item]))
  for (const item of additions) merged.set(activityKey(item), item)
  return [...merged.values()].sort(compareActivity).slice(-MAX_ACTIVITIES)
}

function normalizeBinding(
  input: Omit<ClaudeSessionBoundEvent, 'sdkVersion'> & { sdkVersion?: string },
): ClaudeSessionBoundEvent {
  return {
    claudeSessionId: redactText(input.claudeSessionId, 512),
    sdkVersion: redactText(input.sdkVersion ?? SDK_VERSION, 128),
    cwd: redactText(input.cwd, 4_096),
    ...(input.cliVersion === undefined ? {} : { cliVersion: redactText(input.cliVersion, 128) }),
  }
}

export class ClaudeSidecarRepository {
  readonly root: string
  readonly legacyRoot: string | undefined
  readonly #pending = new Map<string, Promise<unknown>>()
  /** Latest durable projection per session; disk is read once and written through. */
  readonly #latest = new Map<string, ClaudeSidecarProjection>()
  readonly #listeners = new Map<string, Set<(delta: ClaudeSidecarNotification) => void>>()
  /** Notifications published per session, so a reader can spot a hole. */
  readonly #seq = new Map<string, number>()
  /** Streaming transcript segments not yet persisted, keyed by activity key. */
  readonly #live = new Map<string, Map<string, ClaudeActivityEvent>>()
  /** Monotonic revision boost so merged reads advance while text stays in memory. */
  readonly #boost = new Map<string, number>()
  readonly #flushTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: ClaudeSidecarRepositoryOptions = {}) {
    this.root = options.root ?? dshHomePath('plugins', 'dsh-claude', 'sessions')
    this.legacyRoot = options.legacyRoot
      ?? (options.root === undefined ? dshHomePath('plugins', 'dsh-claude-code', 'sessions') : undefined)
  }

  async read(sessionId: string): Promise<ClaudeSidecarProjection> {
    await this.#pending.get(sessionId)?.catch(() => undefined)
    return this.#merged(sessionId, await this.#base(sessionId))
  }

  /** Observe accepted changes for one session; returns the unsubscriber. */
  subscribe(sessionId: string, listener: (delta: ClaudeSidecarNotification) => void): () => void {
    let set = this.#listeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.#listeners.delete(sessionId)
    }
  }

  /** Record streaming assistant prose without touching the disk on the hot
   *  path: subscribers are notified synchronously (as an append when the
   *  redacted text grows in place) and persistence is coalesced. */
  appendTranscriptText(
    sessionId: string,
    value: { turn: number; step: number; ordinal: number; text: string; renderer?: ClaudeRenderMode },
  ): void {
    const normalized = normalizeActivity({ kind: 'text', phase: 'updated', ...value })
    const key = activityKey(normalized)
    let overlay = this.#live.get(sessionId)
    if (overlay === undefined) {
      overlay = new Map()
      this.#live.set(sessionId, overlay)
    }
    const previous = overlay.get(key)
    overlay.set(key, normalized)
    this.#boost.set(sessionId, (this.#boost.get(sessionId) ?? 0) + 1)
    const text = normalized.text ?? ''
    const base = {
      turn: normalized.turn,
      step: normalized.step,
      ordinal: normalized.ordinal,
      ...(normalized.renderer === undefined ? {} : { renderer: normalized.renderer }),
    }
    // Redaction may rewrite earlier characters once a secret completes, so a
    // non-prefix update falls back to a full-text replacement.
    this.#notify(sessionId, previous?.text !== undefined && text.startsWith(previous.text)
      ? { kind: 'text', ...base, append: text.slice(previous.text.length) }
      : { kind: 'text', ...base, text })
    this.#scheduleTextFlush(sessionId)
  }

  /** Persist any pending streaming transcript now (segment close, turn end). */
  flushTranscriptText(sessionId: string): Promise<void> {
    const timer = this.#flushTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.#flushTimers.delete(sessionId)
    }
    return this.#flushLive(sessionId)
  }

  /** How many notifications this session has published. */
  sequence(sessionId: string): number {
    return this.#seq.get(sessionId) ?? 0
  }

  /** Restate where the stream stands without changing anything.
   *
   *  A reader detects a lost delta from the hole the NEXT one leaves, which
   *  never comes when the lost delta was the last of a turn -- exactly the
   *  case that leaves a finished tool group pulsing forever. Called at turn
   *  settlement, this gives that reader the one line it needs to disagree. */
  checkpoint(sessionId: string): void {
    this.#deliver(sessionId, { kind: 'checkpoint', seq: this.sequence(sessionId) })
  }

  #notify(sessionId: string, delta: ClaudeSidecarDelta): void {
    const seq = this.sequence(sessionId) + 1
    this.#seq.set(sessionId, seq)
    this.#deliver(sessionId, { ...delta, seq } as ClaudeSidecarNotification)
  }

  #deliver(sessionId: string, notification: ClaudeSidecarNotification): void {
    const set = this.#listeners.get(sessionId)
    if (set === undefined) return
    for (const listener of [...set]) {
      try {
        listener(notification)
      } catch {
        // A subscriber failure must never affect durable state.
      }
    }
  }

  #merged(sessionId: string, base: ClaudeSidecarProjection): ClaudeSidecarProjection {
    const overlay = this.#live.get(sessionId)
    const boost = this.#boost.get(sessionId) ?? 0
    if ((overlay === undefined || overlay.size === 0) && boost === 0) return base
    return {
      ...base,
      revision: base.revision + boost,
      ...(overlay === undefined || overlay.size === 0
        ? {}
        : { activities: mergeActivities(base.activities, [...overlay.values()]) }),
    }
  }

  async #base(sessionId: string): Promise<ClaudeSidecarProjection> {
    const cached = this.#latest.get(sessionId)
    if (cached !== undefined) return cached
    const loaded = await this.#readNow(sessionId)
    this.#latest.set(sessionId, loaded)
    return loaded
  }

  #scheduleTextFlush(sessionId: string): void {
    if (this.#flushTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.#flushTimers.delete(sessionId)
      void this.#flushLive(sessionId)
    }, TEXT_FLUSH_MS)
    timer.unref?.()
    this.#flushTimers.set(sessionId, timer)
  }

  async #flushLive(sessionId: string): Promise<void> {
    const overlay = this.#live.get(sessionId)
    if (overlay === undefined || overlay.size === 0) return
    const entries = [...overlay.entries()]
    try {
      await this.#update(sessionId, current => ({
        ...current,
        activities: mergeActivities(current.activities, entries.map(([, value]) => value)),
      }))
    } catch {
      // Keep the overlay; the next append or flush retries persistence.
      return
    }
    for (const [key, value] of entries) {
      if (overlay.get(key) === value) overlay.delete(key)
    }
    if (overlay.size === 0) this.#live.delete(sessionId)
  }

  writeBinding(
    sessionId: string,
    value: Omit<ClaudeSessionBoundEvent, 'sdkVersion'> & { sdkVersion?: string },
  ): Promise<ClaudeSidecarProjection> {
    const normalized = normalizeBinding(value)
    return this.#update(sessionId, current => ({ ...current, binding: normalized }))
  }

  appendActivity(
    sessionId: string,
    value: ClaudeActivityInput & { turn: number; step: number; ordinal: number },
  ): Promise<ClaudeSidecarProjection> {
    const normalized = normalizeActivity(value)
    return this.#update(sessionId, current => ({
      ...current,
      activities: mergeActivities(current.activities, [normalized]),
    }), false, { kind: 'activity', activity: normalized })
  }

  writeContextUsage(sessionId: string, value: ClaudeContextUsageInput): Promise<ClaudeSidecarProjection> {
    const normalized = normalizeContextUsage(value)
    return this.#update(sessionId, current => ({ ...current, contextUsage: normalized }), false, { kind: 'contextUsage', value: normalized })
  }

  writeTasks(sessionId: string, value: readonly ClaudeTaskInfo[]): Promise<ClaudeSidecarProjection> {
    const normalized = normalizeTasksEvent(value)
    return this.#update(sessionId, current => ({ ...current, tasks: normalized }), false, { kind: 'tasks', value: normalized })
  }

  /** Land one planned rewind: hidden ranges, surviving anchors, and the fork
   *  target the next Claude spawn consumes.
   *
   *  `droppedFromTurn` also drops the discarded turns' activity. The hidden
   *  ranges are surface seqs and activity records carry none, so a reader that
   *  works in turns — the plan panel, the task board — has nothing to filter
   *  on and would go on showing a plan the session no longer contains. This
   *  projection is rebuildable from the session log, so trimming it is not
   *  losing anything the log still holds. */
  writeRewind(sessionId: string, value: ClaudeRewindState, droppedFromTurn?: number): Promise<ClaudeSidecarProjection> {
    return this.#update(sessionId, current => ({
      ...current,
      rewind: value,
      ...(droppedFromTurn === undefined ? {} : {
        activities: current.activities.filter(activity => activity.turn < droppedFromTurn),
      }),
    }), false, { kind: 'sync' })
  }

  /** Remember where Claude's chain ended for one completed DSH turn. */
  recordRewindAnchor(sessionId: string, turn: number, uuid: string): Promise<ClaudeSidecarProjection> {
    return this.#update(sessionId, current => ({
      ...current,
      rewind: recordRewindAnchor(current.rewind ?? EMPTY_REWIND_STATE, { turn, uuid }),
    }))
  }

  /** Remember the working tree one DSH turn was admitted against. */
  recordRewindSnapshot(sessionId: string, turn: number, tree: string): Promise<ClaudeSidecarProjection> {
    return this.#update(sessionId, current => ({
      ...current,
      rewind: recordRewindSnapshot(current.rewind ?? EMPTY_REWIND_STATE, { turn, tree }),
    }))
  }

  /** Disarm the fork target once a Claude process has resumed at it, so a
   *  later respawn continues the rewound session instead of re-truncating it. */
  clearRewindPending(sessionId: string): Promise<ClaudeSidecarProjection> {
    return this.#update(sessionId, current => (current.rewind?.pending === undefined ? current : {
      ...current,
      rewind: { ranges: current.rewind.ranges, anchors: current.rewind.anchors, snapshots: current.rewind.snapshots },
    }))
  }

  importLegacy(sessionId: string, events: readonly SessionEvent[]): Promise<ClaudeSidecarProjection> {
    const importedActivities = events
      .filter(event => event.type === CLAUDE_ACTIVITY_EVENT)
      .map(event => activity(event.data))
      .filter((item): item is ClaudeActivityEvent => item !== undefined)
    const importedBinding = latestClaudeSessionBinding(events)
    const importedUsage = latestClaudeContextUsage(events)
    const importedTasks = latestClaudeTasks(events)
    return this.#update(sessionId, current => ({
      ...current,
      activities: mergeActivities(importedActivities, current.activities),
      ...(current.binding !== undefined || importedBinding === undefined ? {} : { binding: normalizeBinding(importedBinding) }),
      ...(current.contextUsage !== undefined || importedUsage === undefined ? {} : { contextUsage: normalizeContextUsage(importedUsage) }),
      ...(current.tasks !== undefined || importedTasks === undefined ? {} : { tasks: normalizeTasksEvent(importedTasks.tasks) }),
    }), true, { kind: 'sync' })
  }

  #path(sessionId: string, root = this.root): string {
    if (sessionId.length === 0 || sessionId.length > 1_024) throw new Error('dsh-claude: invalid session id')
    return join(root, `${Buffer.from(sessionId).toString('base64url')}.json`)
  }

  #update(
    sessionId: string,
    change: (current: ClaudeSidecarProjection) => Omit<ClaudeSidecarProjection, 'revision' | 'schemaVersion'> & Partial<Pick<ClaudeSidecarProjection, 'revision' | 'schemaVersion'>>,
    skipUnchanged = false,
    delta?: ClaudeSidecarDelta,
  ): Promise<ClaudeSidecarProjection> {
    const previous = this.#pending.get(sessionId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const current = await this.#base(sessionId)
      const changed = parseClaudeSidecar({
        ...change(current),
        schemaVersion: SIDECAR_SCHEMA_VERSION,
        revision: current.revision,
      })
      if (skipUnchanged && JSON.stringify(changed) === JSON.stringify(current)) return current
      const next = { ...changed, revision: current.revision + 1 }
      await this.#writeNow(sessionId, next)
      this.#latest.set(sessionId, next)
      if (delta !== undefined) this.#notify(sessionId, delta)
      return next
    })
    this.#pending.set(sessionId, operation)
    void operation.finally(() => {
      if (this.#pending.get(sessionId) === operation) this.#pending.delete(sessionId)
    }).catch(() => undefined)
    return operation
  }

  async #readNow(sessionId: string): Promise<ClaudeSidecarProjection> {
    try {
      return parseClaudeSidecar(JSON.parse(await readFile(this.#path(sessionId), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.legacyRoot === undefined) return emptyProjection()
    try {
      return parseClaudeSidecar(JSON.parse(await readFile(this.#path(sessionId, this.legacyRoot), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyProjection()
      throw error
    }
  }

  async #writeNow(sessionId: string, projection: ClaudeSidecarProjection): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    const target = this.#path(sessionId)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(projection)}\n`, { mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      await rename(temporary, target)
      await chmod(target, 0o600)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
