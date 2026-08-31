import { CLAUDE_REPOSITORY_ACTION_PATH } from '../constants.ts'
import type {
  RepositoryActionKind,
  RepositoryActionPreview,
  RepositoryActionRequest,
  RepositoryActionResult,
} from '../repository-actions.ts'
import { PluginRequestError, pluginRead, pluginWrite } from './plugin-transport.ts'

export class RepositoryActionClientError extends Error {
  readonly code?: string
  readonly commit?: string

  constructor(message: string, code?: string, commit?: string) {
    super(message)
    this.name = 'RepositoryActionClientError'
    if (code !== undefined) this.code = code
    if (commit !== undefined) this.commit = commit
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The dialog branches on `code`, so a route refusal keeps arriving as this
 *  class rather than as the transport's own error.
 *
 *  `commit` cannot be carried across: the transport forwards a failed route's
 *  message and error code, not the rest of its body, so a commit that survived
 *  a failed push no longer reaches the dialog that offers its hash. */
function actionError(error: unknown): unknown {
  return error instanceof PluginRequestError ? new RepositoryActionClientError(error.message, error.code) : error
}

function preview(value: unknown): RepositoryActionPreview {
  const input = record(value)
  if (input === undefined || typeof input.root !== 'string' || typeof input.branch !== 'string'
    || typeof input.head !== 'string' || typeof input.fingerprint !== 'string' || !Array.isArray(input.files)
    || typeof input.patch !== 'string' || typeof input.truncated !== 'boolean'
    || typeof input.hasStaged !== 'boolean' || typeof input.hasUnstaged !== 'boolean' || typeof input.hasUntracked !== 'boolean'
    || (input.upstream !== undefined && typeof input.upstream !== 'string')
    || !Array.isArray(input.unpushedCommits) || typeof input.unpushedTruncated !== 'boolean') {
    throw new Error('Invalid repository action preview.')
  }
  for (const file of input.files) {
    const item = record(file)
    if (item === undefined || typeof item.path !== 'string' || typeof item.staged !== 'boolean'
      || typeof item.unstaged !== 'boolean' || typeof item.untracked !== 'boolean') throw new Error('Invalid repository action file.')
  }
  for (const commit of input.unpushedCommits) {
    const item = record(commit)
    if (item === undefined || typeof item.hash !== 'string' || typeof item.subject !== 'string') throw new Error('Invalid repository action commit.')
  }
  return input as unknown as RepositoryActionPreview
}

function result(value: unknown): RepositoryActionResult {
  const input = record(value)
  if (input === undefined || typeof input.commit !== 'string' || typeof input.pushed !== 'boolean'
    || (input.pullRequestUrl !== undefined && typeof input.pullRequestUrl !== 'string')
    || (input.conflicts !== undefined && (!Array.isArray(input.conflicts) || input.conflicts.some(item => typeof item !== 'string')))) throw new Error('Invalid repository action result.')
  return input as unknown as RepositoryActionResult
}

/** The preview only chains local Git; everything that writes may reach a remote. */
export async function loadRepositoryActionPreview(sessionId: string, signal?: AbortSignal): Promise<RepositoryActionPreview> {
  try {
    return preview(await pluginRead<unknown>(`${CLAUDE_REPOSITORY_ACTION_PATH}/preview`, 'git', signal, { query: { sessionId } }))
  } catch (error) {
    throw actionError(error)
  }
}

export async function generateCommitMessage(sessionId: string, fingerprint: string, signal?: AbortSignal): Promise<string> {
  try {
    const value = record(await pluginWrite<unknown>(`${CLAUDE_REPOSITORY_ACTION_PATH}/message`, 'remote', signal, {
      query: { sessionId },
      json: { fingerprint },
    }))
    if (typeof value?.message !== 'string') throw new Error('Invalid generated commit message.')
    return value.message
  } catch (error) {
    throw actionError(error)
  }
}

export async function executeRepositoryAction(
  sessionId: string,
  request: RepositoryActionRequest & { readonly action: RepositoryActionKind },
): Promise<RepositoryActionResult> {
  try {
    return result(await pluginWrite<unknown>(CLAUDE_REPOSITORY_ACTION_PATH, 'remote', undefined, {
      query: { sessionId },
      json: request,
    }))
  } catch (error) {
    throw actionError(error)
  }
}
