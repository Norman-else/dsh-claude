import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RepositoryActionClientError,
  executeRepositoryAction,
  generateCommitMessage,
  loadRepositoryActionPreview,
} from '../src/client/repository-action-api.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('repository action client API', () => {
  it('uses session-scoped same-origin endpoints and validates success payloads', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        root: '/repo', branch: 'main', head: 'a', fingerprint: 'f', files: [
          { path: 'src/a.ts', staged: false, unstaged: true, untracked: false },
        ], patch: 'diff', truncated: false, hasStaged: false, hasUnstaged: true, hasUntracked: false,
        upstream: 'origin/main', unpushedCommits: [{ hash: 'a'.repeat(40), subject: 'Update files' }], unpushedTruncated: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Update files' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ commit: 'b', pushed: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    globalThis.fetch = fetch
    await expect(loadRepositoryActionPreview('session/a')).resolves.toMatchObject({ fingerprint: 'f' })
    await expect(generateCommitMessage('session/a', 'f')).resolves.toBe('Update files')
    await expect(executeRepositoryAction('session/a', {
      action: 'commit-push', fingerprint: 'f', message: 'Update files', includeUnstaged: true,
    })).resolves.toEqual({ commit: 'b', pushed: true })
    expect(fetch.mock.calls[0]?.[0]).toContain('sessionId=session%2Fa')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin' })
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' })
  })

  it('rejects malformed success data and preserves normalized partial-success errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ root: '/repo' }), { status: 200 }))
    await expect(loadRepositoryActionPreview('session')).rejects.toThrow('Invalid repository action preview')
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'push-failed', message: 'Git push failed.', commit: 'commit-oid',
    }), { status: 409 }))
    const error = await executeRepositoryAction('session', {
      action: 'commit-push', fingerprint: 'f', message: 'Update files', includeUnstaged: false,
    }).catch(value => value)
    expect(error).toBeInstanceOf(RepositoryActionClientError)
    expect(error).toMatchObject({ code: 'push-failed', commit: 'commit-oid', message: 'Git push failed.' })
  })
})
