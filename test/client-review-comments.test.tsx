import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { commentAnchorForLine } from '../src/client/ClaudeDiffPanel.tsx'
import { ClaudeReviewComments, reviewCommentChipLabel } from '../src/client/ClaudeReviewComments.tsx'
import type { ClaudeCodeSettingsKey } from '../src/client/locales.ts'
import type { ClaudeClientProjection } from '../src/client/projection.ts'
import * as styles from '../src/client/styles.ts'

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string => {
  let value: string = key
  for (const [name, replacement] of Object.entries(params ?? {})) value = `${value}:${name}=${String(replacement)}`
  return value
}

function hook(value: ClaudeClientProjection) {
  return <T,>(selector: (projection: ClaudeClientProjection) => T): T => selector(value)
}

const projection: ClaudeClientProjection = {
  schemaVersion: 1,
  revision: 1,
  owned: true,
  commands: [],
  activities: [],
  reviewComments: [
    { id: 'c1', path: 'src/client/styles.ts', line: 23, side: 'new', text: 'Use a 10px gap here.' },
    { id: 'c2', path: 'src/index.ts', line: 5, side: 'old', text: 'Why was this removed?' },
  ],
}

describe('Claude review comments', () => {
  it('anchors comments to the working-tree side of each diff row', () => {
    expect(commentAnchorForLine({ line: '+new', kind: 'add', newLine: 12 })).toEqual({ line: 12, side: 'new' })
    expect(commentAnchorForLine({ line: '-old', kind: 'delete', oldLine: 4 })).toEqual({ line: 4, side: 'old' })
    expect(commentAnchorForLine({ line: ' ctx', kind: 'context', oldLine: 4, newLine: 5 })).toEqual({ line: 5, side: 'new' })
    expect(commentAnchorForLine({ line: '@@ -1 +1 @@', kind: 'hunk' })).toBeUndefined()
    expect(commentAnchorForLine({ line: '3 unmodified lines', kind: 'collapsed' })).toBeUndefined()
  })

  it('sizes comment blocks against the visible diff viewport', () => {
    expect(styles.diffCommentBlock).toMatchObject({
      boxSizing: 'border-box',
      width: 'min(640px, calc(var(--dsh-claude-diff-viewport, 520px) - 72px))',
      position: 'sticky',
      left: 62,
    })
  })

  it('labels chips with the file name and line', () => {
    expect(reviewCommentChipLabel({ path: 'src/client/styles.ts', line: 23 })).toBe('styles.ts:23')
    expect(reviewCommentChipLabel({ path: 'README.md', line: 1 })).toBe('README.md:1')
  })

  it('renders one removable chip per pending comment with hover details', () => {
    const markup = renderToStaticMarkup(<ClaudeReviewComments
      useClaudeProjection={hook(projection)}
      t={t}
      sessionId="session"
    />)
    expect(markup).not.toContain('reviewCommentsAttached')
    expect(markup).toContain('styles.ts:23')
    expect(markup).toContain('index.ts:5')
    expect(markup.match(/aria-label="reviewCommentRemove"/gu)).toHaveLength(2)
    expect(markup).toContain('<svg')
    expect(markup).toContain('border-radius:11px')
    expect(markup).toMatch(/aria-label="reviewCommentsClear"[^>]*><svg\b/u)
    expect(markup).not.toContain('aria-label="reviewCommentsSend"')
  })

  it('offers a send button when the composer bridge is injected', () => {
    const markup = renderToStaticMarkup(<ClaudeReviewComments
      useClaudeProjection={hook(projection)}
      t={t}
      sessionId="session"
      submitWith={vi.fn()}
    />)
    expect(markup).toMatch(/aria-label="reviewCommentsSend"[^>]*><svg\b/u)
  })

  it('renders nothing without pending comments or outside owned sessions', () => {
    expect(renderToStaticMarkup(<ClaudeReviewComments
      useClaudeProjection={hook({ ...projection, reviewComments: [] })}
      t={t}
      sessionId="session"
    />)).toBe('')
    expect(renderToStaticMarkup(<ClaudeReviewComments
      useClaudeProjection={hook({ ...projection, owned: false })}
      t={t}
      sessionId="session"
    />)).toBe('')
  })
})
