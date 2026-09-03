import { describe, expect, it, vi } from 'vitest'
import type { ClaudePromptView } from '../src/prompts.ts'
import { createClaudePromptSource } from '../src/client/claude-prompt-source.ts'
import { defaultPromptName } from '../src/client/prompt-api.ts'

const prompts: readonly ClaudePromptView[] = [
  { name: '写单测', description: '照现有测试风格补单测。', body: '照现有测试风格补单测。\n只覆盖新增分支。\n' },
  { name: 'Code review', description: 'Review this diff', body: 'Review this diff and say why.\n' },
]

const session = { sessionId: 'session-1' } as never

function request(query: string, position: 'leading' | 'inline' = 'leading') {
  return { query, position, drilled: false, signal: new AbortController().signal }
}

describe('Claude prompt snippet slash source', () => {
  it('sits under the Claude Code command group', () => {
    const source = createClaudePromptSource('Prompts', async () => prompts)

    expect(source.trigger).toBe('/')
    expect(source.name).toBe('Prompts')
    expect(source.order).toBe(20)
  })

  it('filters by a case-insensitive name query', async () => {
    const source = createClaudePromptSource('Prompts', async () => prompts)

    await expect(source.candidates(session, request('CODE'))).resolves.toEqual([
      { name: 'Code review', description: 'Review this diff' },
    ])
    await expect(source.candidates(session, request('单测'))).resolves.toEqual([
      { name: '写单测', description: '照现有测试风格补单测。' },
    ])
    await expect(source.candidates(session, request(''))).resolves.toHaveLength(2)
  })

  it('stays out of a token typed mid-draft, where a snippet makes no sense', async () => {
    const load = vi.fn(async () => prompts)
    const source = createClaudePromptSource('Prompts', load)

    await expect(source.candidates(session, request('', 'inline'))).resolves.toEqual([])
    expect(load).not.toHaveBeenCalled()
  })

  it('settles a pick as editable draft text rather than a command', async () => {
    const source = createClaudePromptSource('Prompts', async () => prompts)
    await source.candidates(session, request(''))

    const outcome = source.onPick({
      candidate: { name: '写单测' }, session, position: 'leading', via: 'menu', action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    } as never)

    // Plain text: no CommandClaim, so nothing submits on its own.
    expect(outcome).toEqual({ text: '照现有测试风格补单测。\n只覆盖新增分支。\n' })
  })

  it('declines a pick whose prompt is gone from the roll it filtered', async () => {
    const source = createClaudePromptSource('Prompts', async () => prompts)
    await source.candidates(session, request(''))

    expect(source.onPick({
      candidate: { name: 'deleted' }, session, position: 'leading', via: 'menu', action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    } as never)).toBeUndefined()
  })
})

describe('Default prompt file name', () => {
  const at = new Date(2026, 8, 3, 15, 4)

  it('offers the draft opening line, bounded', () => {
    expect(defaultPromptName('照现有测试风格补单测。\n只覆盖新增分支。', at)).toBe('照现有测试风格补单测')
    expect(defaultPromptName('  Review   this  diff  ', at)).toBe('Review this diff')
    expect(defaultPromptName('x'.repeat(80), at)).toHaveLength(40)
  })

  it('scrubs what a file name may not hold rather than proposing it', () => {
    expect(defaultPromptName('fix src/client/index.tsx now', at)).toBe('fix src client index.tsx now')
  })

  it('falls back to a timestamp when the opening line leaves nothing usable', () => {
    expect(defaultPromptName('', at)).toBe('prompt-20260903-1504')
    expect(defaultPromptName('!!! ???', at)).toBe('prompt-20260903-1504')
  })
})
