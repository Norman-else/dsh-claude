import { describe, expect, it } from 'vitest'
import type { ReviewComment } from '../src/review-comments.ts'
import type { PullRequestReviewThread } from '../src/pr-feedback.ts'
import { reviewTargets, type DiffFile } from '../src/client/ClaudeDiffPanel.tsx'

const file = (path: string): DiffFile => ({ path, additions: 1, deletions: 0, lines: [] })

const thread = (id: string, path: string, line: number, resolved = false): PullRequestReviewThread => ({
  id, path, line, side: 'new', resolved, outdated: false,
  comments: [{ id: 1, path, line, side: 'new', author: 'alice', body: 'Look here', url: 'https://github.com/x' }],
})

const comment = (id: string, path: string, line: number): ReviewComment => ({ id, path, line, side: 'new', text: 'mine' })

describe('diff panel review targets', () => {
  it('walks files in panel order and lines in file order', () => {
    const targets = reviewTargets(
      [file('src/a.ts'), file('src/b.ts')],
      [comment('local-1', 'src/a.ts', 12)],
      [thread('T2', 'src/b.ts', 4), thread('T1', 'src/a.ts', 3)],
    )

    expect(targets.map(target => target.key)).toEqual(['thread:T1', 'comment:local-1', 'thread:T2'])
    expect(targets[0]).toMatchObject({ path: 'src/a.ts', line: 3, side: 'new' })
  })

  it('skips settled threads and anything outside the rendered diff', () => {
    const targets = reviewTargets(
      [file('src/a.ts')],
      [comment('local-1', 'src/elsewhere.ts', 2)],
      [thread('T1', 'src/a.ts', 3, true), thread('T2', 'src/a.ts', 9), thread('T3', 'src/gone.ts', 1)],
    )

    // Resolved threads are collapsed by design, and a comment on a file this
    // diff does not render has nowhere to scroll to.
    expect(targets.map(target => target.key)).toEqual(['thread:T2'])
  })

  it('has nothing to walk when the review is empty', () => {
    expect(reviewTargets([file('src/a.ts')], [], [])).toEqual([])
  })
})
