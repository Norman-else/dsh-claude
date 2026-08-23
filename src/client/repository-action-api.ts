import { CLAUDE_REPOSITORY_ACTION_PATH } from '../constants.ts'
import type {
  RepositoryActionKind,
  RepositoryActionPreview,
  RepositoryActionRequest,
  RepositoryActionResult,
} from '../repository-actions.ts'

interface ErrorBody {
  readonly error?: string
  readonly message?: string
  readonly commit?: string
}

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

async function response(pending: Promise<Response>): Promise<unknown> {
  const result = await pending
  const body = await result.json() as unknown
  if (!result.ok) {
    const error = record(body) as ErrorBody | undefined
    throw new RepositoryActionClientError(
      typeof error?.message === 'string' ? error.message : 'Repository action failed.',
      typeof error?.error === 'string' ? error.error : undefined,
      typeof error?.commit === 'string' ? error.commit : undefined,
    )
  }
  return body
}

function preview(value: unknown): RepositoryActionPreview {
  const input = record(value)
  if (input === undefined || typeof input.root !== 'string' || typeof input.branch !== 'string'
    || typeof input.head !== 'string' || typeof input.fingerprint !== 'string' || !Array.isArray(input.files)
    || typeof input.patch !== 'string' || typeof input.truncated !== 'boolean'
    || typeof input.hasStaged !== 'boolean' || typeof input.hasUnstaged !== 'boolean' || typeof input.hasUntracked !== 'boolean') {
    throw new Error('Invalid repository action preview.')
  }
  for (const file of input.files) {
    const item = record(file)
    if (item === undefined || typeof item.path !== 'string' || typeof item.staged !== 'boolean'
      || typeof item.unstaged !== 'boolean' || typeof item.untracked !== 'boolean') throw new Error('Invalid repository action file.')
  }
  return input as unknown as RepositoryActionPreview
}

function result(value: unknown): RepositoryActionResult {
  const input = record(value)
  if (input === undefined || typeof input.commit !== 'string' || typeof input.pushed !== 'boolean'
    || (input.pullRequestUrl !== undefined && typeof input.pullRequestUrl !== 'string')) throw new Error('Invalid repository action result.')
  return input as unknown as RepositoryActionResult
}

function endpoint(path: string, sessionId: string): string {
  return `${CLAUDE_REPOSITORY_ACTION_PATH}${path}?sessionId=${encodeURIComponent(sessionId)}`
}

export async function loadRepositoryActionPreview(sessionId: string, signal?: AbortSignal): Promise<RepositoryActionPreview> {
  return preview(await response(fetch(endpoint('/preview', sessionId), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })))
}

export async function generateCommitMessage(sessionId: string, fingerprint: string, signal?: AbortSignal): Promise<string> {
  const value = record(await response(fetch(endpoint('/message', sessionId), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint }),
    ...(signal === undefined ? {} : { signal }),
  })))
  if (typeof value?.message !== 'string') throw new Error('Invalid generated commit message.')
  return value.message
}

export function executeRepositoryAction(
  sessionId: string,
  request: RepositoryActionRequest & { readonly action: RepositoryActionKind },
): Promise<RepositoryActionResult> {
  return response(fetch(endpoint('', sessionId), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })).then(result)
}
