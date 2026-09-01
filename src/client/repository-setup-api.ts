import { CLAUDE_REPOSITORY_FILE_PATH, CLAUDE_REPOSITORY_SETUP_PATH, CLAUDE_REPOSITORY_STATUS_PATH } from '../constants.ts'
import type { RepositoryBranchList, RepositoryCleanupResult, RepositorySetupResult, RepositorySetupStage } from '../repository-setup.ts'
import type { RepositoryStatus } from '../repository-status.ts'
import { PluginRequestError, pluginNdjson, pluginRead, pluginWrite } from './plugin-transport.ts'

export type RepositoryPreparationStage = RepositorySetupStage
  | 'creating-workspace'
  | 'starting-session'
  | 'transferring-draft'
  | 'submitting'

const HOST_STAGES = new Set<RepositorySetupStage>([
  'inspecting', 'fetching', 'summarizing', 'creating-worktree', 'saving-worktree', 'switching-branch',
])

/** The draft only has to describe the work; the host truncates it again before
 *  summarizing, and the setup route caps the whole body at 16 KiB. */
const MAX_INTENT_CHARS = 2_000

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

export function loadRepositoryBranches(cwd: string, signal?: AbortSignal): Promise<RepositoryBranchList> {
  return pluginRead<RepositoryBranchList>(`${CLAUDE_REPOSITORY_SETUP_PATH}/branches`, 'git', signal, { query: { cwd } })
}

/** Pull remote refs down first, then list: a POST because `--prune` rewrites
 *  this checkout's remote-tracking refs, and on the remote budget because the
 *  host's own `git fetch` runs for up to a minute. */
export async function refreshRepositoryBranches(cwd: string, signal?: AbortSignal): Promise<RepositoryBranchList> {
  try {
    return await pluginWrite<RepositoryBranchList>(`${CLAUDE_REPOSITORY_SETUP_PATH}/branches/refresh`, 'remote', signal, {
      json: { cwd },
    })
  } catch (error) {
    // A Host still running the previously loaded server bundle has no refresh
    // route at all; that is a stale process, not a repository that refused. The
    // capsule reads the sentinel off the message, so keep saying it in those words.
    if (error instanceof PluginRequestError && error.reason === 'route-missing') throw new Error('route-missing')
    throw error
  }
}

export async function prepareRepository(
  cwd: string,
  branch: string,
  worktree: boolean,
  branchName?: string,
  onProgress: (stage: RepositoryPreparationStage) => void = () => {},
  /** Composer draft to name a generated worktree branch after; ignored when
   *  `branchName` already fixes the name. */
  intent?: string,
): Promise<RepositorySetupResult> {
  // The stream lane holds its permit for the life of the response and gives it
  // back when this signal aborts, so every exit from the read aborts it.
  const carrier = new AbortController()
  try {
    const reader = await pluginNdjson(CLAUDE_REPOSITORY_SETUP_PATH, carrier.signal, {
      method: 'POST',
      json: {
        cwd,
        branch,
        worktree,
        ...(branchName === undefined ? {} : { branchName }),
        ...(intent === undefined || intent.trim().length === 0 ? {} : { intent: intent.slice(0, MAX_INTENT_CHARS) }),
      },
    })
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
  } finally {
    carrier.abort()
  }
}

export async function bindRepositoryLease(leaseId: string, sessionId: string): Promise<void> {
  await pluginWrite<unknown>(`${CLAUDE_REPOSITORY_SETUP_PATH}/bind`, 'remote', undefined, { json: { leaseId, sessionId } })
}

export async function cleanupMergedRepository(path: string, baseBranch: string): Promise<RepositoryCleanupResult> {
  const body = await pluginWrite<Record<string, unknown>>(`${CLAUDE_REPOSITORY_SETUP_PATH}/cleanup`, 'remote', undefined, {
    json: { path, baseBranch },
  })
  if ((body.mode !== 'worktree' && body.mode !== 'checkout') || typeof body.root !== 'string' || typeof body.branch !== 'string') {
    throw new Error('Invalid repository cleanup response.')
  }
  return body as unknown as RepositoryCleanupResult
}

/** Ask the Host to reconcile worktrees against the workspace registry now.
 *  Deleting a workspace only touches the registry, so this kick is what makes
 *  the worktree and its sessions go without waiting out the sweep interval. */
export async function sweepWorktrees(): Promise<void> {
  await pluginWrite(`${CLAUDE_REPOSITORY_SETUP_PATH}/sweep`, 'fast')
}

/** Lines [from, to] of a working-tree file plus its total line count, for expanding unmodified diff context. */
export async function loadRepositoryFileLines(cwd: string, path: string, from: number, to: number, signal?: AbortSignal): Promise<{ lines: readonly string[]; total: number }> {
  const body = await pluginRead<Record<string, unknown>>(CLAUDE_REPOSITORY_FILE_PATH, 'git', signal, {
    query: { cwd, path, from: String(from), to: String(to) },
  })
  if (!Array.isArray(body.lines) || typeof body.total !== 'number') throw new Error('Invalid repository file response.')
  return { lines: body.lines.map(String), total: body.total }
}

export async function loadRepositoryStatusFor(cwd: string, signal?: AbortSignal): Promise<RepositoryStatus> {
  const body = await pluginRead<Record<string, unknown>>(CLAUDE_REPOSITORY_STATUS_PATH, 'git', signal, { query: { cwd } })
  if (typeof body.status !== 'string' || typeof body.cwd !== 'string') throw new Error('Invalid repository status response.')
  return body as unknown as RepositoryStatus
}
