import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PullRequestReviewThread } from '../src/pr-feedback.ts'
import { ReviewThreadCard } from '../src/client/ReviewThreadCard.tsx'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replaceAll(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

const thread = (overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread => ({
  id: 'T1',
  path: 'src/a.ts',
  line: 3,
  side: 'new',
  resolved: false,
  outdated: false,
  comments: [
    { id: 1, path: 'src/a.ts', line: 3, side: 'new', author: 'mercoder-dev', bot: true, body: 'Concurrent withdrawals report changes twice', url: 'https://github.com/x#1', createdAt: '2026-08-28T17:00:00Z' },
    { id: 2, path: 'src/a.ts', line: 3, side: 'new', author: 'mercoder-dev', bot: true, body: 'Fixed as of 131d096 — resolving.', url: 'https://github.com/x#2', createdAt: '2026-08-28T20:50:00Z' },
  ],
  ...overrides,
})

const NOW = Date.parse('2026-08-28T21:00:00Z')

function card(value: PullRequestReviewThread) {
  return renderToStaticMarkup(<ReviewThreadCard
    thread={value}
    t={t}
    now={NOW}
    suggest={vi.fn(async () => [])}
    onReply={vi.fn(async () => undefined)}
    onResolvedChange={vi.fn(async () => undefined)}
  />)
}

describe('review thread card', () => {
  it('stacks a conversation under one anchor with reply and resolve offered', () => {
    const markup = card(thread())

    // Comment bodies are sanitized HTML, which needs a DOM; the card's own
    // structure is what static rendering can speak for.
    expect(markup).toContain('@mercoder-dev')
    // The whole conversation lives in one card rather than one card per comment.
    expect(markup).toContain('https://github.com/x#2')
    expect(markup).toContain('https://github.com/x#1')
    expect(markup).toContain('Reply')
    expect(markup).toContain('Resolve')
  })

  it('gives every comment the identity row GitHub gives it', () => {
    const markup = card(thread())

    // The screenshot's thread is one bot talking to itself, so the answer to
    // "which one is the reply" has to be the age, not the name.
    expect(markup.match(/@mercoder-dev</gu)).toHaveLength(2)
    expect(markup).toContain('4h ago')
    expect(markup).toContain('&lt;1h ago')
    // GitHub marks app accounts rather than spelling the suffix out.
    expect(markup.match(/>Bot</gu)).toHaveLength(2)
    expect(markup).not.toContain('[bot]')
    // Comments are separated blocks at one indentation level, GitHub-style.
    expect(markup.match(/border-top/gu)).toHaveLength(1)
    expect(markup).not.toContain('border-left')
  })

  it('folds a resolved thread down to a line that says who settled it', () => {
    const markup = card(thread({ resolved: true }))

    expect(markup).toContain('Resolved')
    expect(markup).toContain('@mercoder-dev')
    // Collapsed: the rest of the conversation and its actions stay behind the
    // disclosure rather than crowding the diff.
    expect(markup).not.toContain('Fixed as of')
    expect(markup).not.toContain('Unresolve')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('Concurrent withdrawals report changes twice')
  })

  it('marks a thread the branch has moved past', () => {
    expect(card(thread({ outdated: true }))).toContain('Outdated')
  })
})
