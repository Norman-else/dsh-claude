import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_REPOSITORY_FEEDBACK_PATH } from '../src/constants.ts'
import type { PullRequestReviewThread } from '../src/pr-feedback.ts'
import {
  composeCommentsPrompt,
  loadMentionableUsers,
  loadPullRequestThreads,
  replyToReviewThread,
  setReviewThreadResolved,
} from '../src/client/pr-feedback-api.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const comment = (id: number, author: string, body: string) => ({
  id, path: 'src/a.ts', line: 3, side: 'new' as const, author, body, url: `https://github.com/x#${id}`,
})

const thread = (id: string, resolved: boolean, comments: ReturnType<typeof comment>[]): PullRequestReviewThread => ({
  id, path: 'src/a.ts', line: 3, side: 'new', resolved, outdated: false, comments,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pull request feedback client', () => {
  it('loads review threads and drops malformed ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      threads: [
        thread('T1', false, [comment(1, 'alice', 'Fix it')]),
        { id: 'T2', path: 'src/b.ts', side: 'new', resolved: false, outdated: false, comments: 'nope' },
        { path: 'src/c.ts', side: 'new', resolved: false, outdated: false, comments: [] },
      ],
    })))

    const threads = await loadPullRequestThreads('session-1', 12)
    expect(threads.map(item => item.id)).toEqual(['T1'])
    expect(threads[0]?.comments[0]?.author).toBe('alice')
  })

  it('posts a reply and a resolution for one thread', async () => {
    const request = vi.fn(async (url: string) => (url.includes('/reply')
      ? jsonResponse({ comment: comment(9, 'me', 'Thanks @alice') })
      : jsonResponse({ resolved: true })))
    vi.stubGlobal('fetch', request)

    await expect(replyToReviewThread('session-1', 12, 3, 'Thanks @alice')).resolves.toMatchObject({ id: 9, author: 'me' })
    const [replyUrl, replyInit] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(replyUrl).toBe(`${CLAUDE_REPOSITORY_FEEDBACK_PATH}/reply?sessionId=session-1&number=12`)
    expect(replyInit.method).toBe('POST')
    expect(JSON.parse(String(replyInit.body))).toEqual({ commentId: 3, body: 'Thanks @alice' })

    await expect(setReviewThreadResolved('session-1', 12, 'T1', true)).resolves.toBe(true)
    const [, resolveInit] = request.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(String(resolveInit.body))).toEqual({ threadId: 'T1', resolved: true })
  })

  it('asks for mention candidates by prefix', async () => {
    const request = vi.fn(async () => jsonResponse({ users: [{ login: 'alice' }, { login: 42 }] }))
    vi.stubGlobal('fetch', request)

    await expect(loadMentionableUsers('session-1', 12, 'al')).resolves.toEqual([{ login: 'alice' }])
    expect(String(request.mock.calls[0]?.[0])).toContain('q=al')
  })

  it('never bothers Claude with threads the reviewers already resolved', () => {
    const prompt = composeCommentsPrompt([
      thread('T1', false, [comment(1, 'alice', 'Fix it'), comment(2, 'bob', 'Same here')]),
      thread('T2', true, [comment(3, 'carol', 'Old news')]),
    ])

    expect(prompt).toContain('src/a.ts:3 (@alice): Fix it')
    // The rest of the conversation is context Claude needs to answer the first.
    expect(prompt).toContain('(@bob): Same here')
    expect(prompt).not.toContain('Old news')
    expect(composeCommentsPrompt([thread('T2', true, [comment(3, 'carol', 'Old news')])])).toBe('')
  })

  it('keeps a bot review readable and drops the checklist meant for the bot', () => {
    const body = [
      '### Per-order preflight exhausts rate limits',
      '**Medium Severity**',
      'Fetch transaction details only for ineligible orders.',
      '',
      '<sup>Reviewed by Navi for commit `c834761`.</sup>',
      '',
      '---',
      '',
      '**Actions** <!-- navi-autofix -->',
      '',
      '- [ ] <!-- navi-autofix --> **Apply fix** — Navi pushes a fix commit to this PR',
    ].join('\n')

    const prompt = composeCommentsPrompt([thread('T1', false, [comment(1, 'mercoder-dev', body)])])

    // The heading starts a line of its own instead of running into the author.
    expect(prompt).toContain('- src/a.ts:3 (@mercoder-dev):\n\n  ### Per-order preflight exhausts rate limits')
    expect(prompt).toContain('  Fetch transaction details only for ineligible orders.')
    expect(prompt).not.toContain('Apply fix')
    expect(prompt).not.toContain('Reviewed by Navi')
    expect(prompt).not.toContain('navi-autofix')
    // A plain comment still reads as one line.
    expect(composeCommentsPrompt([thread('T2', false, [comment(2, 'alice', 'Fix it')])])).toContain('(@alice): Fix it')
  })
})
