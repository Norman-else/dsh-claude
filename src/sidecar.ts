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

export interface ClaudeSidecarProjection {
  readonly schemaVersion: typeof SIDECAR_SCHEMA_VERSION
  readonly revision: number
  readonly binding?: ClaudeSessionBoundEvent
  readonly activities: readonly ClaudeActivityEvent[]
  readonly contextUsage?: ClaudeContextUsageEvent
  readonly tasks?: ClaudeTasksEvent
}

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

const ACTIVITY_KINDS = new Set(['status', 'thinking', 'tool-call', 'tool-result', 'permission', 'question', 'subagent', 'usage', 'warning', 'error'])
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

  constructor(options: ClaudeSidecarRepositoryOptions = {}) {
    this.root = options.root ?? dshHomePath('plugins', 'dsh-claude', 'sessions')
    this.legacyRoot = options.legacyRoot
      ?? (options.root === undefined ? dshHomePath('plugins', 'dsh-claude-code', 'sessions') : undefined)
  }

  async read(sessionId: string): Promise<ClaudeSidecarProjection> {
    await this.#pending.get(sessionId)?.catch(() => undefined)
    return this.#readNow(sessionId)
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
    }))
  }

  writeContextUsage(sessionId: string, value: ClaudeContextUsageInput): Promise<ClaudeSidecarProjection> {
    const normalized = normalizeContextUsage(value)
    return this.#update(sessionId, current => ({ ...current, contextUsage: normalized }))
  }

  writeTasks(sessionId: string, value: readonly ClaudeTaskInfo[]): Promise<ClaudeSidecarProjection> {
    const normalized = normalizeTasksEvent(value)
    return this.#update(sessionId, current => ({ ...current, tasks: normalized }))
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
    }), true)
  }

  #path(sessionId: string, root = this.root): string {
    if (sessionId.length === 0 || sessionId.length > 1_024) throw new Error('dsh-claude: invalid session id')
    return join(root, `${Buffer.from(sessionId).toString('base64url')}.json`)
  }

  #update(
    sessionId: string,
    change: (current: ClaudeSidecarProjection) => Omit<ClaudeSidecarProjection, 'revision' | 'schemaVersion'> & Partial<Pick<ClaudeSidecarProjection, 'revision' | 'schemaVersion'>>,
    skipUnchanged = false,
  ): Promise<ClaudeSidecarProjection> {
    const previous = this.#pending.get(sessionId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const current = await this.#readNow(sessionId)
      const changed = parseClaudeSidecar({
        ...change(current),
        schemaVersion: SIDECAR_SCHEMA_VERSION,
        revision: current.revision,
      })
      if (skipUnchanged && JSON.stringify(changed) === JSON.stringify(current)) return current
      const next = { ...changed, revision: current.revision + 1 }
      await this.#writeNow(sessionId, next)
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
