import { describe, expect, it } from 'vitest'
import { reviewCommentMarkdown } from '../src/client/ClaudeDiffPanel.tsx'

describe('review comment markdown', () => {
  it('drops the bot machinery the Markdown renderer would show verbatim', () => {
    const body = [
      '### Large exports cannot be uploaded back',
      '',
      '**Medium Severity**',
      '',
      'This loop writes the entire filtered set.',
      '',
      '**Actions** <!-- navi-autofix -->',
      '',
      '- [ ] <!-- navi-autofix --> **Apply fix** — Navi pushes a fix commit',
    ].join('\n')
    const cleaned = reviewCommentMarkdown(body)
    expect(cleaned).not.toContain('<!--')
    expect(cleaned).toContain('### Large exports cannot be uploaded back')
    expect(cleaned).toContain('- [ ]  **Apply fix**')
    // No blank run is left where a marker used to sit on its own line.
    expect(cleaned).not.toMatch(/\n{3}/u)
    expect(cleaned).toBe(cleaned.trim())
  })

  it('leaves an ordinary human comment untouched', () => {
    expect(reviewCommentMarkdown('Please rename this to `total`.')).toBe('Please rename this to `total`.')
  })
})
