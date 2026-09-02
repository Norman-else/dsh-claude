// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { commentBodyHtml, installCommentSanitizerHooks, renderCommentBody } from '../src/client/comment-markdown.ts'

describe('review comment renderer', () => {
  it('keeps a bot\'s single newline as a line break, the way GitHub shows it', () => {
    const html = renderCommentBody('**Low Severity**\nThese additions exercise several cases.')

    expect(html).toContain('<br>')
    expect(html).not.toContain('</strong> These')
  })

  it('renders GitHub-flavoured Markdown the way the comment was written', () => {
    const html = renderCommentBody([
      '### Large exports cannot be uploaded back',
      '',
      '**Medium Severity** — see `upload`.',
      '',
      '- [ ] **Apply fix** — Navi pushes a fix commit',
      '- [x] done',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n'))
    expect(html).toContain('<h3>Large exports cannot be uploaded back</h3>')
    expect(html).toContain('<strong>Medium Severity</strong>')
    expect(html).toContain('<code>upload</code>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<table>')
  })

  it('keeps the HTML review bots write instead of printing it', () => {
    installCommentSanitizerHooks()
    const html = renderCommentBody('<sup>Reviewed by Navi for commit <code>5b68736</code>.</sup>')
    expect(html).toContain('<sup>')
    expect(html).toContain('<code>5b68736</code>')
    expect(html).not.toContain('&lt;sup&gt;')
    const details = renderCommentBody('<details><summary>Why</summary>\n\nBecause.\n\n</details>')
    expect(details).toContain('<details>')
    expect(details).toContain('<summary>Why</summary>')
  })

  it('drops the machinery comments bots address themselves with', () => {
    const html = renderCommentBody('**Actions** <!-- navi-autofix -->\n\n- [ ] <!-- navi-autofix --> **Apply fix**')
    expect(html).not.toContain('navi-autofix')
    expect(html).toContain('<strong>Actions</strong>')
  })

  it('removes everything outside the allowlist', () => {
    const html = renderCommentBody([
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">click</a>',
      '<iframe src="https://evil.example"></iframe>',
      '<p style="position:fixed">styled</p>',
    ].join('\n'))
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('style=')
    expect(html).toContain('styled')
  })

  it('sends links out to the browser and leaves checkboxes inert', () => {
    installCommentSanitizerHooks()
    const html = renderCommentBody('[pr](https://github.com/o/r/pull/1)\n\n- [ ] task')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('disabled')
  })

  it('yields nothing rather than unsanitized HTML without a DOM', () => {
    const unsupported = { sanitize: () => 'x', isSupported: false } as never
    expect(renderCommentBody('# hi', unsupported)).toBe('')
    // The parse step itself stays pure and DOM-free.
    expect(commentBodyHtml('# hi')).toContain('<h1>hi</h1>')
  })
})
