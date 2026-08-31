// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'

import {
  CLAUDE_MARKDOWN_ENHANCED_CSS,
  CLAUDE_MARKDOWN_SCOPE,
  CLAUDE_MARKDOWN_THEME_CSS,
  applyClaudeMarkdownTheme,
  ensureClaudeMarkdownTheme,
} from '../src/client/markdown-theme.ts'
import { visibleGlobalSettings, type GlobalSettingView } from '../src/client/ClaudeCodeSettings.tsx'

/** The prose hues the enhanced sheet is defined by. Asserting the values —
 *  not just "some colour" — is what keeps a careless edit from silently
 *  swapping the palette the user opted into. */
const PROSE_COLOURS = ['#7C9EFF', '#FFB454', '#5BD6C0', '#FF7A93', '#F2C94C', '#9AA3B2', '#4DA3FF']

function sheet(): string {
  const tag = document.head.querySelector<HTMLStyleElement>('style[data-dsh-claude-markdown-theme]')
  expect(tag, 'the theme sheet is not attached').not.toBeNull()
  return tag?.textContent ?? ''
}

beforeEach(() => {
  for (const tag of document.head.querySelectorAll('style[data-dsh-claude-markdown-theme]')) tag.remove()
})

describe('enhanced prose sheet', () => {
  it('keeps every prose colour out of the base sheet', () => {
    // The base sheet is what a user who never opted in sees; a colour leaking
    // into it makes the setting look broken in the 'plain' position.
    for (const colour of PROSE_COLOURS) {
      expect(CLAUDE_MARKDOWN_THEME_CSS, `base sheet leaks ${colour}`).not.toContain(colour)
    }
  })

  it('colours prose, list markers and the code block only in the enhanced sheet', () => {
    for (const colour of PROSE_COLOURS) {
      expect(CLAUDE_MARKDOWN_ENHANCED_CSS, `enhanced sheet misses ${colour}`).toContain(colour)
    }
    expect(CLAUDE_MARKDOWN_ENHANCED_CSS).toContain('li::marker')
    expect(CLAUDE_MARKDOWN_ENHANCED_CSS).toContain('#0F1218')
    expect(CLAUDE_MARKDOWN_ENHANCED_CSS).toContain('#2E3546')
  })

  it('repeats the dark-theme inline-code selector so it outranks the clay rule', () => {
    // `body[data-ds-dark-theme] .scope :not(pre)>code` is (0,2,3); a flat
    // `.scope :not(pre)>code` is (0,1,3) and loses under a dark body no matter
    // how late it appears. The enhanced sheet must carry both selectors.
    expect(CLAUDE_MARKDOWN_ENHANCED_CSS)
      .toContain(`body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE} :not(pre)>code`)
  })

  it('also colours the review comment body, which uses its own renderer', () => {
    // GitHub comments never reach MarkdownText — they go through
    // comment-markdown.ts into `.dshClaudeDiffCommentBody`.
    expect(CLAUDE_MARKDOWN_ENHANCED_CSS).toContain('.dshClaudeDiffCommentBody')
  })
})

describe('applying the theme', () => {
  it('attaches the base sheet alone by default', () => {
    ensureClaudeMarkdownTheme()
    expect(sheet()).toContain('display:contents')
    expect(sheet()).not.toContain('#7C9EFF')
  })

  it('adds and removes the enhanced rules without stacking style tags', () => {
    ensureClaudeMarkdownTheme()
    applyClaudeMarkdownTheme('enhanced')
    expect(sheet()).toContain('#7C9EFF')

    applyClaudeMarkdownTheme('plain')
    expect(sheet()).not.toContain('#7C9EFF')
    // Still the base sheet, not an empty one: reverting must not strip Pierre.
    expect(sheet()).toContain('display:contents')
    expect(document.head.querySelectorAll('style[data-dsh-claude-markdown-theme]')).toHaveLength(1)
  })

  it('attaches the sheet when applied before anything rendered', () => {
    // Boot reads the setting before the first Markdown mounts, so apply() has
    // to stand alone rather than assume ensure() ran first.
    applyClaudeMarkdownTheme('enhanced')
    expect(sheet()).toContain('#7C9EFF')
  })
})

describe('settings row visibility', () => {
  const row = (key: string, value: string): GlobalSettingView => ({
    key,
    kind: 'select',
    value,
    options: [{ value, label: value, source: 'built-in' }],
    effect: 'immediate',
  })

  it('hides the prose setting while the Host draws the transcript', () => {
    // 'native' means DSH's own renderer paints the turn; this package's
    // stylesheet never reaches it, so the row would promise nothing.
    const keys = visibleGlobalSettings([row('renderer', 'native'), row('prose', 'plain')]).map(s => s.key)
    expect(keys).toEqual(['renderer'])
  })

  it('shows it under the plugin renderer', () => {
    const keys = visibleGlobalSettings([row('renderer', 'plugin'), row('prose', 'plain')]).map(s => s.key)
    expect(keys).toEqual(['renderer', 'prose'])
  })

  it('shows it when the renderer setting is missing entirely', () => {
    // A payload without `renderer` is a Host older than that setting; failing
    // open keeps the prose row reachable rather than hiding it forever.
    expect(visibleGlobalSettings([row('prose', 'enhanced')]).map(s => s.key)).toEqual(['prose'])
  })
})
