import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { EMPTY_REWIND_STATE, isRewound, mergeRewindRanges, planRewind, recordRewindAnchor, recordRewindSnapshot, rewindRestoreTree } from '../src/rewind.ts'
import { ClaudeSidecarRepository } from '../src/sidecar.ts'

const roots: string[] = []

async function repository(): Promise<ClaudeSidecarRepository> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-rewind-'))
  roots.push(root)
  return new ClaudeSidecarRepository({ root })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Two turns: user message, turn/start, turn/end, per turn. */
function log(): SessionEvent[] {
  return [
    { type: 'user/message', seq: 1, time: 1, data: {} },
    { type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } },
    { type: 'user/message', seq: 4, time: 4, data: {} },
    { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } },
    { type: 'turn/end', seq: 6, time: 6, data: { turn: 2 } },
  ] as unknown as SessionEvent[]
}

describe('rewind planning', () => {
  it('hides the message through the log tail and forks at the kept turn', () => {
    const state = recordRewindAnchor(recordRewindAnchor(EMPTY_REWIND_STATE, { turn: 1, uuid: 'a' }), { turn: 2, uuid: 'b' })
    const planned = planRewind(state, log(), 4)
    expect(planned?.ranges).toEqual([{ start: 4, end: 6 }])
    expect(planned?.pending).toEqual({ resumeAt: 'a' })
    // Turn 2 no longer exists in Claude's chain, so its anchor goes with it.
    expect(planned?.anchors).toEqual([{ turn: 1, uuid: 'a' }])
  })

  it('starts a fresh Claude session when every turn is discarded', () => {
    const state = recordRewindAnchor(EMPTY_REWIND_STATE, { turn: 1, uuid: 'a' })
    const planned = planRewind(state, log(), 1)
    expect(planned?.ranges).toEqual([{ start: 1, end: 6 }])
    expect(planned?.pending).toEqual({ fresh: true })
    expect(planned?.anchors).toEqual([])
  })

  it('keeps every anchor for a message no turn ever opened', () => {
    const events = log().slice(0, 3).concat({ type: 'user/message', seq: 4, time: 4, data: {} } as unknown as SessionEvent)
    const state = recordRewindAnchor(EMPTY_REWIND_STATE, { turn: 1, uuid: 'a' })
    expect(planRewind(state, events, 4)?.pending).toEqual({ resumeAt: 'a' })
  })

  it('refuses a seq the log does not reach', () => {
    expect(planRewind(EMPTY_REWIND_STATE, log(), 99)).toBeUndefined()
    expect(planRewind(EMPTY_REWIND_STATE, [], 1)).toBeUndefined()
  })

  it('absorbs an earlier rewind into the later hidden block', () => {
    const merged = mergeRewindRanges([{ start: 10, end: 20 }], { start: 4, end: 25 })
    expect(merged).toEqual([{ start: 4, end: 25 }])
    expect(mergeRewindRanges([{ start: 4, end: 6 }], { start: 7, end: 9 })).toEqual([{ start: 4, end: 9 }])
    expect(mergeRewindRanges([{ start: 4, end: 6 }], { start: 20, end: 22 }))
      .toEqual([{ start: 4, end: 6 }, { start: 20, end: 22 }])
  })

  it('reports membership per seq', () => {
    const ranges = [{ start: 4, end: 6 }]
    expect(isRewound(ranges, 3)).toBe(false)
    expect(isRewound(ranges, 4)).toBe(true)
    expect(isRewound(ranges, 6)).toBe(true)
    expect(isRewound(ranges, 7)).toBe(false)
  })

  it('restores the tree of the first discarded turn', () => {
    const state = recordRewindSnapshot(recordRewindSnapshot(EMPTY_REWIND_STATE, { turn: 1, tree: 'tree-1' }), { turn: 2, tree: 'tree-2' })
    // Rewinding the second message undoes turn 2, so the checkout goes back to
    // the tree turn 2 was admitted against -- not turn 1's.
    expect(rewindRestoreTree(state, log(), 4)).toBe('tree-2')
    expect(rewindRestoreTree(state, log(), 1)).toBe('tree-1')
    // A message no turn ever opened discards nothing, so nothing is restored.
    const pending = log().slice(0, 3).concat({ type: 'user/message', seq: 4, time: 4, data: {} } as unknown as SessionEvent)
    expect(rewindRestoreTree(state, pending, 4)).toBeUndefined()
    // A turn that ran before snapshots existed has no tree to go back to.
    expect(rewindRestoreTree(EMPTY_REWIND_STATE, log(), 4)).toBeUndefined()
  })

  it('drops the snapshots of the turns it discards', () => {
    const state = recordRewindSnapshot(recordRewindSnapshot(EMPTY_REWIND_STATE, { turn: 1, tree: 'tree-1' }), { turn: 2, tree: 'tree-2' })
    expect(planRewind(state, log(), 4)?.snapshots).toEqual([{ turn: 1, tree: 'tree-1' }])
    expect(planRewind(state, log(), 1)?.snapshots).toEqual([])
  })

  it('replaces the snapshot of a re-run turn', () => {
    const state = recordRewindSnapshot(recordRewindSnapshot(EMPTY_REWIND_STATE, { turn: 1, tree: 'a' }), { turn: 1, tree: 'b' })
    expect(state.snapshots).toEqual([{ turn: 1, tree: 'b' }])
  })

  it('replaces the anchor of a re-run turn', () => {
    const state = recordRewindAnchor(recordRewindAnchor(EMPTY_REWIND_STATE, { turn: 1, uuid: 'a' }), { turn: 1, uuid: 'b' })
    expect(state.anchors).toEqual([{ turn: 1, uuid: 'b' }])
  })
})

describe('rewind persistence', () => {
  it('round-trips the rewind block and consumes the fork target once', async () => {
    const store = await repository()
    await store.recordRewindAnchor('session', 1, 'uuid-1')
    const planned = planRewind((await store.read('session')).rewind ?? EMPTY_REWIND_STATE, log(), 4)
    expect(planned).toBeDefined()
    await store.writeRewind('session', planned as NonNullable<typeof planned>)
    const stored = new ClaudeSidecarRepository({ root: store.root })
    expect((await stored.read('session')).rewind).toEqual({
      ranges: [{ start: 4, end: 6 }],
      anchors: [{ turn: 1, uuid: 'uuid-1' }],
      snapshots: [],
      pending: { resumeAt: 'uuid-1' },
    })
    await store.clearRewindPending('session')
    const reread = await new ClaudeSidecarRepository({ root: store.root }).read('session')
    expect(reread.rewind?.pending).toBeUndefined()
    expect(reread.rewind?.ranges).toEqual([{ start: 4, end: 6 }])
  })

  it('drops the discarded turns\' activity along with their surface rows', async () => {
    const store = await repository()
    await store.appendActivity('session', { turn: 1, step: 0, ordinal: 0, kind: 'text', text: 'kept' })
    await store.appendActivity('session', { turn: 2, step: 0, ordinal: 0, kind: 'text', text: 'discarded' })
    const planned = planRewind(EMPTY_REWIND_STATE, log(), 4)
    // Turn 2 is the first turn the cut at seq 4 discards.
    await store.writeRewind('session', planned as NonNullable<typeof planned>, 2)
    // Hidden ranges are surface seqs; a reader that works in turns has nothing
    // to filter on, so the projection must not still carry the records.
    const stored = await new ClaudeSidecarRepository({ root: store.root }).read('session')
    expect(stored.activities.map(activity => activity.text)).toEqual(['kept'])
  })

  it('keeps every activity when the cut discards no turn', async () => {
    const store = await repository()
    await store.appendActivity('session', { turn: 1, step: 0, ordinal: 0, kind: 'text', text: 'kept' })
    const planned = planRewind(EMPTY_REWIND_STATE, log(), 6)
    await store.writeRewind('session', planned as NonNullable<typeof planned>, undefined)
    expect((await store.read('session')).activities).toHaveLength(1)
  })
})
