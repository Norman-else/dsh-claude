import { describe, expect, it } from 'vitest'
import { injectReviewComments } from '../src/adapter.ts'
import { ReviewCommentStore, formatReviewComments } from '../src/review-comments.ts'

describe('review comment store', () => {
  it('adds bounded comments and lists them per session', () => {
    const store = new ReviewCommentStore()
    const comment = store.add('session', { path: ' src/a.ts ', line: 12, side: 'new', text: '  Rename this. ' })
    expect(comment).toMatchObject({ path: 'src/a.ts', line: 12, side: 'new', text: 'Rename this.' })
    expect(comment.id.length).toBeGreaterThan(0)
    expect(store.list('session')).toEqual([comment])
    expect(store.list('other')).toEqual([])
  })

  it('keeps a start line only for real ranges and rejects inverted ones', () => {
    const store = new ReviewCommentStore()
    expect(store.add('s', { path: 'a.ts', line: 5, startLine: 3, side: 'new', text: 'range' })).toMatchObject({ line: 5, startLine: 3 })
    expect(store.add('s', { path: 'a.ts', line: 5, startLine: 5, side: 'new', text: 'single' })).not.toHaveProperty('startLine')
    expect(() => store.add('s', { path: 'a.ts', line: 5, startLine: 6, side: 'new', text: 'bad' })).toThrow(/start line/u)
  })

  it('rejects invalid paths, lines, sides, and text', () => {
    const store = new ReviewCommentStore()
    expect(() => store.add('s', { path: '', line: 1, side: 'new', text: 'x' })).toThrow('path')
    expect(() => store.add('s', { path: 'a\nb', line: 1, side: 'new', text: 'x' })).toThrow('path')
    expect(() => store.add('s', { path: 'a.ts', line: 0, side: 'new', text: 'x' })).toThrow('line')
    expect(() => store.add('s', { path: 'a.ts', line: 1.5, side: 'new', text: 'x' })).toThrow('line')
    expect(() => store.add('s', { path: 'a.ts', line: 1, side: 'left', text: 'x' })).toThrow('side')
    expect(() => store.add('s', { path: 'a.ts', line: 1, side: 'new', text: '' })).toThrow('text')
    expect(() => store.add('s', { path: 'a.ts', line: 1, side: 'new', text: 'x'.repeat(2_001) })).toThrow('text')
  })

  it('caps the pending queue per session', () => {
    const store = new ReviewCommentStore()
    for (let index = 0; index < 50; index += 1) store.add('s', { path: 'a.ts', line: index + 1, side: 'new', text: 'x' })
    expect(() => store.add('s', { path: 'a.ts', line: 99, side: 'new', text: 'x' })).toThrow('Too many')
    expect(store.add('other', { path: 'a.ts', line: 1, side: 'new', text: 'x' })).toBeDefined()
  })

  it('removes by id and drains everything for the next turn', () => {
    const store = new ReviewCommentStore()
    const first = store.add('s', { path: 'a.ts', line: 1, side: 'new', text: 'one' })
    const second = store.add('s', { path: 'b.ts', line: 2, side: 'old', text: 'two' })
    expect(store.remove('s', 'missing')).toBe(false)
    expect(store.remove('s', first.id)).toBe(true)
    expect(store.list('s')).toEqual([second])
    expect(store.drain('s')).toEqual([second])
    expect(store.list('s')).toEqual([])
    expect(store.drain('s')).toEqual([])
  })

  it('formats drained comments into one prompt block', () => {
    const block = formatReviewComments([
      { id: '1', path: 'src/a.ts', line: 12, side: 'new', text: 'Rename this.' },
      { id: '2', path: 'src/b.ts', line: 3, side: 'old', text: 'Why removed?' },
      { id: '3', path: 'src/c.ts', line: 44, startLine: 42, side: 'new', text: 'Extract this.' },
    ])
    expect(block).toContain('<user-review-comments>')
    expect(block).toContain('1. src/a.ts:12 — Rename this.')
    expect(block).toContain('2. src/b.ts:3 (old side) — Why removed?')
    expect(block).toContain('3. src/c.ts:42-44 — Extract this.')
    expect(block).toContain('</user-review-comments>')
  })
})

describe('review comment prompt injection', () => {
  const comments = [{ id: '1', path: 'src/a.ts', line: 12, side: 'new' as const, text: 'Rename this.' }]

  it('prepends the block to string prompts and block prompts', () => {
    const text = injectReviewComments('please fix', comments)
    expect(text).toMatch(/^<user-review-comments>[\s\S]*<\/user-review-comments>\n\nplease fix$/u)
    const blocks = injectReviewComments([{ type: 'text', text: 'please fix' }], comments)
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text).toContain('src/a.ts:12')
    expect(blocks[1]).toEqual({ type: 'text', text: 'please fix' })
  })

  it('returns the prompt untouched without pending comments', () => {
    expect(injectReviewComments('please fix', [])).toBe('please fix')
  })
})
