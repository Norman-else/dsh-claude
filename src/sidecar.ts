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
import { CLAUDE_ACTIVITY_EVENT, SDK_VERSION } from './constants.ts'

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
}

/** Change notification published to live subscribers after each accepted write. */
export type ClaudeSidecarDelta =
  | { kind: 'text'; turn: number; step: number; ordinal: number; append?: string; text?: string }
  | { kind: 'activity'; activity: ClaudeActivityEvent }
  | { kind: 'contextUsage'; value: ClaudeContextUsageEvent }
  | { kind: 'tasks'; value: ClaudeTasksEvent }
  | { kind: 'sync' }

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

const ACTIVITY_KINDS = new Set(['text', 'status', 'thinking', 'tool-call', 'tool-result', 'permission', 'question', 'subagent', 'usage', 'warning', 'error'])
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
  if ((input.binding !== undefined && parsedBinding === undefined)
    || (input.contextUsage !== undefined && parsedUsage === undefined)
    || (input.tasks !== undefined && parsedTasks === undefined)) {
    throw new Error('dsh-claude: invalid sidecar projection')
  }
  return {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    revision: input.revision,
    activities: activities as ClaudeActivityEvent[],
    ...(parsedBinding === undefined ? {} : { binding: parsedBinding }),
    ...(parsedUsage === undefined ? {} : { contextUsage: parsedUsage }),
    ...(parsedTasks === undefined ? {} : { tasks: parsedTasks }),
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
  readonly #listeners = new Map<string, Set<(delta: ClaudeSidecarDelta) => void>>()
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
  subscribe(sessionId: string, listener: (delta: ClaudeSidecarDelta) => void): () => void {
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
    value: { turn: number; step: number; ordinal: number; text: string },
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
    const base = { turn: normalized.turn, step: normalized.step, ordinal: normalized.ordinal }
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

  #notify(sessionId: string, delta: ClaudeSidecarDelta): void {
    const set = this.#listeners.get(sessionId)
    if (set === undefined) return
    for (const listener of [...set]) {
      try {
        listener(delta)
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
