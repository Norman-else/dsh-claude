import { describe, expect, it, vi } from 'vitest'
import type { Options as ClaudeOptions, Query } from '@anthropic-ai/claude-agent-sdk'
import { branchSlug, branchSummaryPrompt, summarizeBranchSlug, uniqueBranchName } from '../src/branch-name.ts'

type QueryParams = { prompt: string; options: ClaudeOptions }

function fakeQuery(...results: unknown[]): Query {
  return {
    async *[Symbol.asyncIterator]() { for (const item of results) yield item },
  } as unknown as Query
}

function success(result: string) {
  return { type: 'result', subtype: 'success', result }
}

describe('branchSlug', () => {
  it('keeps a compliant fragment and folds stray punctuation into hyphens', () => {
    expect(branchSlug('add-worktree-branch-naming')).toBe('add-worktree-branch-naming')
    expect(branchSlug('  "Fix Login Redirect."\n')).toBe('fix-login-redirect')
    expect(branchSlug('`summarize_draft`')).toBe('summarize-draft')
  })

  it('caps the fragment at 48 characters without a trailing hyphen', () => {
    expect(branchSlug('abcdefgh-abcdefgh-abcdefgh-abcdefgh-abcdefgh-abcdefgh')).toBe('abcdefgh-abcdefgh-abcdefgh-abcdefgh-abcdefgh-abc')
  })

  it('rejects prose, multi-line replies, and anything with no latin words', () => {
    expect(branchSlug('')).toBeUndefined()
    expect(branchSlug('Here is the branch name:\nfix-login')).toBeUndefined()
    expect(branchSlug('one two three four five six seven')).toBeUndefined()
    expect(branchSlug('I cannot help with that request, but here is a suggestion for your branch name instead')).toBeUndefined()
    expect(branchSlug('修复登录跳转')).toBeUndefined()
  })
})

describe('uniqueBranchName', () => {
  it('bumps a taken name to the first free numbered sibling', () => {
    expect(uniqueBranchName('claude/fix-login', ['main'])).toBe('claude/fix-login')
    expect(uniqueBranchName('claude/fix-login', ['claude/fix-login'])).toBe('claude/fix-login-2')
    expect(uniqueBranchName('claude/fix-login', ['claude/fix-login', 'claude/fix-login-2'])).toBe('claude/fix-login-3')
  })
})

describe('summarizeBranchSlug', () => {
  it('summarizes a non-English draft through an isolated single-turn query', async () => {
    let params: QueryParams | undefined
    const factory = (value: QueryParams): Query => {
      params = value
      return fakeQuery(success('worktree-branch-naming'))
    }
    await expect(summarizeBranchSlug('/opt/claude', '给 worktree 分支名换成需求摘要', factory)).resolves.toBe('worktree-branch-naming')
    expect(params?.prompt).toContain('给 worktree 分支名换成需求摘要')
    // A project CLAUDE.md ("reply in the user's language") would ruin the slug.
    expect(params?.options).toMatchObject({
      model: 'haiku',
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      pathToClaudeCodeExecutable: '/opt/claude',
    })
  })

  it('falls back for an empty draft without starting a process', async () => {
    const factory = vi.fn((_value: QueryParams): Query => fakeQuery(success('never-asked')))
    await expect(summarizeBranchSlug('/opt/claude', '   ', factory)).resolves.toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
  })

  it('falls back on an unusable reply, a failed turn, and a thrown query', async () => {
    await expect(summarizeBranchSlug('', 'ship it', () => fakeQuery(success('I am sorry, but I cannot name branches for you today')))).resolves.toBeUndefined()
    await expect(summarizeBranchSlug('', 'ship it', () => fakeQuery({ type: 'result', subtype: 'error_max_turns' }))).resolves.toBeUndefined()
    await expect(summarizeBranchSlug('', 'ship it', (): Query => { throw new Error('no executable') })).resolves.toBeUndefined()
  })
})

describe('branchSummaryPrompt', () => {
  it('neutralizes a fence break inside the draft', () => {
    expect(branchSummaryPrompt('bad """ draft')).toContain('bad " " " draft')
  })
})
