import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ClaudeMarkdown } from '../src/client/markdown-labels.tsx'
import { CLAUDE_MARKDOWN_SCOPE, CLAUDE_MARKDOWN_THEME_CSS } from '../src/client/markdown-theme.ts'

/** Every token the Host's code block resolves its colours from. A palette that
 *  misses one leaves that token on the Host's stock colour, which reads as a
 *  stray highlight rather than an obvious break. */
const SHIKI_TOKENS = [
  '--shiki-background',
  '--shiki-foreground',
  '--shiki-token-comment',
  '--shiki-token-constant',
  '--shiki-token-function',
  '--shiki-token-keyword',
  '--shiki-token-link',
  '--shiki-token-parameter',
  '--shiki-token-punctuation',
  '--shiki-token-string',
  '--shiki-token-string-expression',
]

const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }

function block(selector: string): string {
  const at = CLAUDE_MARKDOWN_THEME_CSS.indexOf(selector)
  expect(at, `${selector} is not in the sheet`).toBeGreaterThanOrEqual(0)
  const open = CLAUDE_MARKDOWN_THEME_CSS.indexOf('{', at)
  return CLAUDE_MARKDOWN_THEME_CSS.slice(open, CLAUDE_MARKDOWN_THEME_CSS.indexOf('}', open))
}

describe('Claude markdown palette', () => {
  it('redefines every shiki token in both themes', () => {
    const light = block(`.${CLAUDE_MARKDOWN_SCOPE}{`)
    const dark = block(`body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE}{`)

    for (const token of SHIKI_TOKENS) {
      expect(light, `light theme misses ${token}`).toContain(`${token}:`)
      expect(dark, `dark theme misses ${token}`).toContain(`${token}:`)
    }
  })

  it('keeps the scope out of layout', () => {
    // The wrapper exists only to carry custom properties; a box here would
    // change the spacing of every rendered turn.
    expect(block(`.${CLAUDE_MARKDOWN_SCOPE}{`)).toContain('display:contents')
  })

  it('tints inline code without reaching into fenced blocks', () => {
    expect(CLAUDE_MARKDOWN_THEME_CSS).toContain(`.${CLAUDE_MARKDOWN_SCOPE} :not(pre)>code{color:`)
  })

  it('raises the inline-code size past the Host declaration it competes with', () => {
    // The Host declares `font-size: 0.875em !important` on the same selector,
    // so a plain declaration here is unreachable — dropping the flag would
    // silently restore a chip shorter than the prose around it.
    expect(block(`.${CLAUDE_MARKDOWN_SCOPE} :not(pre)>code{`)).toContain('font-size:1.05em!important')
  })

  it('lifts the banner bar out of flow without hiding the copy button', () => {
    // The Host draws a sticky bar carrying the language name AND the copy
    // button; Claude draws none and floats its actions. Hiding the bar
    // outright would take the copy button with it.
    expect(CLAUDE_MARKDOWN_THEME_CSS).toContain('[class*="bannerWrap"]{position:absolute')
    expect(CLAUDE_MARKDOWN_THEME_CSS).toContain('[class*="infostring"]{display:none}')
    expect(CLAUDE_MARKDOWN_THEME_CSS).not.toContain('[class*="copyButton"]{display:none}')
  })

  it('scrolls long lines instead of wrapping them', () => {
    expect(CLAUDE_MARKDOWN_THEME_CSS).toContain('pre{white-space:pre;word-break:normal;overflow-x:auto}')
  })

  it('scopes the palette onto rendered Markdown', () => {
    expect(renderToStaticMarkup(<ClaudeMarkdown text="`x`" labels={labels} />))
      .toContain(`class="${CLAUDE_MARKDOWN_SCOPE}"`)
  })
})
