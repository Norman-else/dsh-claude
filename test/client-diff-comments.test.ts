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

  it('unwraps the inline HTML the renderer would print verbatim', () => {
    expect(reviewCommentMarkdown('<sup>Reviewed by Navi for commit `5b68736`.</sup>'))
      .toBe('Reviewed by Navi for commit `5b68736`.')
    expect(reviewCommentMarkdown('one<br>two<br />three')).toBe('one\ntwo\nthree')
    expect(reviewCommentMarkdown('<details><summary>Why</summary>\n\nBecause.\n</details>')).toBe('Why\n\nBecause.')
    // A Markdown autolink is not a tag and must survive.
    expect(reviewCommentMarkdown('see <https://example.com/x>')).toBe('see <https://example.com/x>')
  })

  it('leaves an ordinary human comment untouched', () => {
    expect(reviewCommentMarkdown('Please rename this to `total`.')).toBe('Please rename this to `total`.')
  })
})
