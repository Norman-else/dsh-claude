import { describe, expect, it } from 'vitest'
import {
  AUTO_FIX_FOOTER,
  autoFixEnabled,
  autoFixMemory,
  checksSignature,
  planAutoFix,
  rememberAutoFix,
  setAutoFixEnabled,
} from '../src/client/auto-fix.ts'

const comment = (id: number, body = 'Fix it') => ({ id, path: 'src/a.ts', line: 3, side: 'new' as const, author: 'alice', body, url: `https://github.com/x/${id}` })
const check = (name: string, run: number) => ({ name, link: `https://github.com/o/r/actions/runs/${run}/job/${run * 10}` })

describe('pull request auto fix planner', () => {
  it('hands each comment and each failing CI run to Claude exactly once', () => {
    const empty = { handledCommentIds: new Set<number>() }
    expect(planAutoFix(empty, [], []).prompt).toBeUndefined()

    const first = planAutoFix(empty, [comment(1), comment(2)], [check('build', 9)])
    expect(first.prompt).toContain('src/a.ts:3 (@alice)')
    expect(first.prompt).toContain('## build')
    expect(first.prompt?.endsWith(AUTO_FIX_FOOTER)).toBe(true)
    expect([...first.memory.handledCommentIds]).toEqual([1, 2])
    expect(first.memory.handledChecksSignature).toBe(checksSignature([check('build', 9)]))

    const repeat = planAutoFix(first.memory, [comment(1), comment(2)], [check('build', 9)])
    expect(repeat.prompt).toBeUndefined()
    expect(repeat.memory).toBe(first.memory)

    const newComment = planAutoFix(first.memory, [comment(1), comment(2), comment(3, 'Also this')], [check('build', 9)])
    expect(newComment.prompt).toContain('Also this')
    expect(newComment.prompt).not.toContain('## build')
    expect([...newComment.memory.handledCommentIds]).toEqual([1, 2, 3])

    const rerun = planAutoFix(newComment.memory, [comment(1), comment(2), comment(3)], [check('build', 10)])
    expect(rerun.prompt).toContain('## build')
    expect(rerun.prompt).not.toContain('Also this')

    const recovered = planAutoFix(rerun.memory, [comment(1), comment(2), comment(3)], [])
    expect(recovered.prompt).toBeUndefined()
    expect(recovered.memory.handledChecksSignature).toBe(checksSignature([check('build', 10)]))
  })

  it('keeps the toggle and memory per session', () => {
    expect(autoFixEnabled('s1')).toBe(false)
    setAutoFixEnabled('s1', true)
    expect(autoFixEnabled('s1')).toBe(true)
    expect(autoFixEnabled('s2')).toBe(false)
    rememberAutoFix('s1', { handledCommentIds: new Set([7]) })
    expect([...autoFixMemory('s1').handledCommentIds]).toEqual([7])
    expect([...autoFixMemory('s2').handledCommentIds]).toEqual([])
  })
})
