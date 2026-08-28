import { describe, expect, it } from 'vitest'
import { applyMention, mentionQueryAt } from '../src/client/mention.ts'

describe('reply composer mentions', () => {
  it('offers completion only for a handle the caret is still typing', () => {
    expect(mentionQueryAt('Thanks @ali', 11)).toEqual({ query: 'ali', start: 7 })
    // Right after the sigil: everyone is a candidate.
    expect(mentionQueryAt('Thanks @', 8)).toEqual({ query: '', start: 7 })
    expect(mentionQueryAt('@alice', 6)).toEqual({ query: 'alice', start: 0 })
    expect(mentionQueryAt('cc @a-b_c1', 10)).toEqual({ query: 'a-b_c1', start: 3 })

    // Not a mention: an address, a finished handle, or a caret that moved on.
    expect(mentionQueryAt('mail me@example.com', 19)).toBeUndefined()
    expect(mentionQueryAt('Thanks @alice for the fix', 25)).toBeUndefined()
    expect(mentionQueryAt('Thanks @alice\n', 14)).toBeUndefined()
    expect(mentionQueryAt('no handle here', 5)).toBeUndefined()
    // A login cannot be this long, so the popup stands down instead of querying.
    expect(mentionQueryAt(`@${'a'.repeat(64)}`, 65)).toBeUndefined()
  })

  it('replaces the typed handle and leaves the caret past the trailing space', () => {
    expect(applyMention('Thanks @ali', 11, { query: 'ali', start: 7 }, 'alice'))
      .toEqual({ text: 'Thanks @alice ', caret: 14 })
    // Text after the caret survives untouched.
    expect(applyMention('Thanks @ali for this', 11, { query: 'ali', start: 7 }, 'alice'))
      .toEqual({ text: 'Thanks @alice  for this', caret: 14 })
    expect(applyMention('@', 1, { query: '', start: 0 }, 'mercoder-dev[bot]'))
      .toEqual({ text: '@mercoder-dev[bot] ', caret: 19 })
  })
})
