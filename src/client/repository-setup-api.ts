import { CLAUDE_REPOSITORY_FILE_PATH, CLAUDE_REPOSITORY_SETUP_PATH, CLAUDE_REPOSITORY_STATUS_PATH } from '../constants.ts'
import type { RepositoryBranchList, RepositoryCleanupResult, RepositorySetupResult, RepositorySetupStage } from '../repository-setup.ts'
import type { RepositoryStatus } from '../repository-status.ts'
import { PLUGIN_ACTION_TIMEOUT_MS, PLUGIN_READ_TIMEOUT_MS, pluginRequestSignal } from './plugin-request.ts'

interface ErrorBody {
  readonly message?: string
  readonly error?: string
}

export type RepositoryPreparationStage = RepositorySetupStage
  | 'creating-workspace'
  | 'starting-session'
  | 'transferring-draft'
  | 'submitting'

const HOST_STAGES = new Set<RepositorySetupStage>([
  'inspecting', 'fetching', 'creating-worktree', 'saving-worktree', 'switching-branch',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function setupResult(value: unknown): RepositorySetupResult | undefined {
  const item = record(value)
  if (item === undefined || (item.mode !== 'checkout' && item.mode !== 'worktree')
    || typeof item.root !== 'string' || typeof item.path !== 'string' || typeof item.branch !== 'string'
    || (item.leaseId !== undefined && typeof item.leaseId !== 'string')) return undefined
  return item as unknown as RepositorySetupResult
}

export function parseRepositorySetupEvent(
  line: string,
  onProgress: (stage: RepositoryPreparationStage) => void,
): RepositorySetupResult | undefined {
  const event = record(JSON.parse(line) as unknown)
  if (event?.type === 'progress' && typeof event.stage === 'string' && HOST_STAGES.has(event.stage as RepositorySetupStage)) {
    onProgress(event.stage as RepositorySetupStage)
    return undefined
  }
  if (event?.type === 'complete') {
    const result = setupResult(event.result)
    if (result !== undefined) return result
  }
  if (event?.type === 'error' && typeof event.message === 'string') throw new Error(event.message)
  throw new Error('Invalid repository setup progress response.')
}

async function response<T>(pending: Promise<Response>): Promise<T> {
  const result = await pending
  const body = await result.json() as T | ErrorBody
  if (!result.ok) {
    const error = body as ErrorBody
    throw new Error(error.message ?? error.error ?? 'Repository setup failed.')
  }
  return body as T
}

/** A wedged host must surface as an error; the hero has no other way out of its loading state. */
export const BRANCH_LOAD_TIMEOUT_MS = 15_000

export function loadRepositoryBranches(cwd: string, signal?: AbortSignal): Promise<RepositoryBranchList> {
  return response(fetch(`${CLAUDE_REPOSITORY_SETUP_PATH}/branches?cwd=${encodeURIComponent(cwd)}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    signal: pluginRequestSignal(BRANCH_LOAD_TIMEOUT_MS, signal),
  }))
}

export async function prepareRepository(
  cwd: string,
  branch: string,
  worktree: boolean,
  branchName?: string,
  onProgress: (stage: RepositoryPreparationStage) => void = () => {},
): Promise<RepositorySetupResult> {
  const result = await fetch(CLAUDE_REPOSITORY_SETUP_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, branch, worktree, ...(branchName === undefined ? {} : { branchName }) }),
  })
  if (!result.ok) {
    const body = await result.json() as ErrorBody
    throw new Error(body.message ?? body.error ?? 'Repository setup failed.')
  }
  if (result.body === null) throw new Error('Repository setup progress stream is unavailable.')
  const reader = result.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed: RepositorySetupResult | undefined
  while (true) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value, { stream: !chunk.done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim().length === 0) continue
      const value = parseRepositorySetupEvent(line, onProgress)
      if (value !== undefined) completed = value
    }
    if (chunk.done) break
  }
  if (buffer.trim().length > 0) {
    const value = parseRepositorySetupEvent(buffer, onProgress)
    if (value !== undefined) completed = value
  }
  if (completed === undefined) throw new Error('Repository setup progress ended before completion.')
  return completed
}

/** Bookkeeping, not a gate: a wedged host must fail this instead of hanging on
 *  a connection the rest of the flow is waiting behind. */
export const LEASE_BIND_TIMEOUT_MS = 10_000

export async function bindRepositoryLease(leaseId: string, sessionId: string): Promise<void> {
  await response(fetch(`${CLAUDE_REPOSITORY_SETUP_PATH}/bind`, {
    method: 'POST',
    credentials: 'same-origin',
    signal: pluginRequestSignal(LEASE_BIND_TIMEOUT_MS),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ leaseId, sessionId }),
  }))
}

export async function cleanupMergedRepository(path: string, baseBranch: string): Promise<RepositoryCleanupResult> {
  const body = await response<Record<string, unknown>>(fetch(`${CLAUDE_REPOSITORY_SETUP_PATH}/cleanup`, {
    signal: pluginRequestSignal(PLUGIN_ACTION_TIMEOUT_MS),
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ path, baseBranch }),
  }))
  if ((body.mode !== 'worktree' && body.mode !== 'checkout') || typeof body.root !== 'string' || typeof body.branch !== 'string') {
    throw new Error('Invalid repository cleanup response.')
  }
  return body as unknown as RepositoryCleanupResult
}

/** Lines [from, to] of a working-tree file plus its total line count, for expanding unmodified diff context. */
export async function loadRepositoryFileLines(cwd: string, path: string, from: number, to: number, signal?: AbortSignal): Promise<{ lines: readonly string[]; total: number }> {
  const query = `cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&from=${from}&to=${to}`
  const body = await response<Record<string, unknown>>(fetch(`${CLAUDE_REPOSITORY_FILE_PATH}?${query}`, {
    signal: pluginRequestSignal(PLUGIN_READ_TIMEOUT_MS),
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  }))
  if (!Array.isArray(body.lines) || typeof body.total !== 'number') throw new Error('Invalid repository file response.')
  return { lines: body.lines.map(String), total: body.total }
}

export async function loadRepositoryStatusFor(cwd: string, signal?: AbortSignal): Promise<RepositoryStatus> {
  const body = await response<Record<string, unknown>>(fetch(`${CLAUDE_REPOSITORY_STATUS_PATH}?cwd=${encodeURIComponent(cwd)}`, {
    signal: pluginRequestSignal(PLUGIN_READ_TIMEOUT_MS),
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  }))
  if (typeof body.status !== 'string' || typeof body.cwd !== 'string') throw new Error('Invalid repository status response.')
  return body as unknown as RepositoryStatus
}
