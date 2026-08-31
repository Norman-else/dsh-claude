/** Claude Code's code presentation over the Host's Markdown renderer.
 *
 *  This package renders no Markdown of its own — prose, fenced blocks and the
 *  copy affordance all come from the Host's `MarkdownText` primitive. What it
 *  can own is what that primitive reads: the palette (custom properties) and
 *  the block's chrome (CSS over the primitive's own markup).
 *
 *  PARITY IS PARTIAL BY CONSTRUCTION. Both renderers highlight with shiki, but
 *  Claude Code's desktop build loads a full TextMate theme (Pierre Dark /
 *  Pierre Light Soft: 248 tokenColor rules over 424 scopes) and bakes the
 *  resolved colour into every span, while the Host loads shiki's legacy
 *  `css-variables` theme, which collapses every scope into the eleven buckets
 *  below. Those eleven carry the colours that dominate a code block —
 *  keywords, strings, comments, functions, numbers — and nothing here can
 *  recover the rest: `constant.numeric` and `constant` are two different
 *  colours in Pierre and one bucket here, and Pierre's string-coloured string
 *  delimiters share this sheet's single punctuation bucket. Matching the rest
 *  means this package running its own shiki, which is a different decision
 *  with a different cost.
 *
 *  Every rule fails open the way `host-chrome` does: the palette is
 *  declarations on this package's own wrapper, and the chrome rules match the
 *  primitive's CSS Module local names, so a Host that renames either simply
 *  stops matching and its stock presentation comes back.
 */

/** Wrapper class carrying the palette and scoping the chrome rules.
 *  `display:contents` so the extra element generates no box — custom
 *  properties inherit through it regardless. */
export const CLAUDE_MARKDOWN_SCOPE = 'dsh-claude-markdown'

/** Pierre mapped onto the Host's eleven buckets. Each entry names the theme
 *  scope the value was taken from, because the mapping — not the colour — is
 *  the part a reader has to check. */
const PIERRE_DARK: readonly (readonly [string, string, string])[] = [
  // NOT Pierre's `editor.background`: Claude paints the chat code block from a
  // UI surface token, deliberately decoupled from the syntax theme. Its
  // `--code-theme-*-bg` hook is only ever read with a fallback (it stays unset
  // until a custom code theme is picked), so the default is
  // `--pane-surface-bg` -> `--cds-surface-2`, one step LIGHTER than the page.
  ['--shiki-background', '#1a1a19', 'UI surface (--cds-surface-2)'],
  ['--shiki-foreground', '#fafafa', 'editor.foreground'],
  ['--shiki-token-comment', '#737373', 'comment'],
  ['--shiki-token-keyword', '#ff678d', 'keyword, storage.type'],
  ['--shiki-token-string', '#5ecc71', 'string'],
  // Pierre's template-interpolation colour, which is what this bucket is for.
  ['--shiki-token-string-expression', '#ffa359', 'punctuation.section.embedded'],
  ['--shiki-token-function', '#9d6afb', 'entity.name.function'],
  // Numbers and booleans, not the generic `constant` (#ffd452): numeric
  // literals are the overwhelmingly more common token, and one bucket cannot
  // hold both.
  ['--shiki-token-constant', '#68cdf2', 'constant.numeric, constant.language'],
  ['--shiki-token-parameter', '#a3a3a3', 'variable.parameter'],
  ['--shiki-token-punctuation', '#636363', 'punctuation'],
  ['--shiki-token-link', '#ff678d', 'markup.underline.link.markdown'],
]

const PIERRE_LIGHT: readonly (readonly [string, string, string])[] = [
  ['--shiki-background', '#ffffff', 'UI surface (--cds-surface-2)'],
  ['--shiki-foreground', '#525252', 'editor.foreground'],
  ['--shiki-token-comment', '#8a8a8a', 'comment'],
  ['--shiki-token-keyword', '#ff678d', 'keyword, storage.type'],
  ['--shiki-token-string', '#0dbe4e', 'string'],
  ['--shiki-token-string-expression', '#fe8c2c', 'punctuation.section.embedded'],
  ['--shiki-token-function', '#9d6afb', 'entity.name.function'],
  ['--shiki-token-constant', '#08c0ef', 'constant.numeric, constant.language'],
  ['--shiki-token-parameter', '#737373', 'variable.parameter'],
  ['--shiki-token-punctuation', '#737373', 'punctuation'],
  ['--shiki-token-link', '#ff678d', 'markup.underline.link.markdown'],
]

/** Claude's brand clay (`--cds-hsl-clay`), its inline-code TEXT colour; the
 *  emphasized ramp is the light-theme variant. The chip's fill is deliberately
 *  NOT tinted with it — see {@link INLINE_FILL_DARK}. */
const CLAY = '#d97757'
const CLAY_EMPHASIZED = '#c8603f'

/** The inline-code chip fill: a neutral 4% wash (Claude's `--t1`), not a tint
 *  of the text colour. A clay-tinted fill reads as a coloured box around every
 *  identifier; the neutral one disappears into the surface and lets the text
 *  carry the accent, which is what the chip is for. */
const INLINE_FILL_DARK = 'hsl(0 0% 100% / .04)'
const INLINE_FILL_LIGHT = 'hsl(0 0% 4.3% / .04)'

/** Block corner radius (Claude's `--r6`), against the Host's own 12px. */
const BLOCK_RADIUS = '8px'

/** @param banner - equal to `surface` on purpose: the bar is floated out of
 *  the way below, so this colour is only reached if those chrome selectors
 *  miss, and a bar that matches the block is the neutral fallback. */
function palette(entries: readonly (readonly [string, string, string])[], surface: string, banner: string, inlineFill: string): string {
  return [
    ...entries.map(([name, value]) => `${name}:${value};`),
    `--dsw-alias-markdown-code-block:${surface};`,
    `--dsw-alias-markdown-code-block-banner:${banner};`,
    `--dsw-alias-markdown-inline-code:${inlineFill}`,
  ].join('')
}

export const CLAUDE_MARKDOWN_THEME_CSS = [
  `.${CLAUDE_MARKDOWN_SCOPE}{display:contents;`,
    palette(PIERRE_LIGHT, '#ffffff', '#ffffff', INLINE_FILL_LIGHT),
  '}',
  `body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE}{`,
    palette(PIERRE_DARK, '#1a1a19', '#1a1a19', INLINE_FILL_DARK),
  '}',
  // The Host's inline-code rule sets a background but no colour, so the chip
  // inherits body text. Claude's build tints it with the brand clay.
  // Claude's chip is tighter than the Host's 6px/0 5px.
  `.${CLAUDE_MARKDOWN_SCOPE} :not(pre)>code{color:${CLAY_EMPHASIZED};border-radius:4px;padding:1px 2px}`,
  `body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE} :not(pre)>code{color:${CLAY}}`,

  // --- Chrome -------------------------------------------------------------
  // Selectors match the CSS Module LOCAL names, not the emitted classes: only
  // the build-hash part changes across Host releases (same technique as
  // `host-chrome`). A rename makes these miss and the stock chrome returns.
  //
  // The Host draws a sticky banner bar across the block's top carrying the
  // language name and the copy button. Claude draws no bar at all: its actions
  // float over the code at the top right. The bar is therefore lifted out of
  // flow and stripped rather than hidden — hiding it would take the copy
  // button with it.
  `.${CLAUDE_MARKDOWN_SCOPE} [class*="bannerWrap"]{position:absolute;top:0;right:0;z-index:7;background:transparent;border-radius:0}`,
  `.${CLAUDE_MARKDOWN_SCOPE} [class*="banner"]:not([class*="bannerWrap"]){background:transparent;padding:6px 8px}`,
  `.${CLAUDE_MARKDOWN_SCOPE} [class*="infostring"]{display:none}`,
  // The Host wraps long lines (`pre-wrap` + `break-all`); Claude keeps lines
  // intact and scrolls. Specificity beats the primitive's `:where(pre)`.
  `.${CLAUDE_MARKDOWN_SCOPE} pre{white-space:pre;word-break:normal;overflow-x:auto}`,
  `.${CLAUDE_MARKDOWN_SCOPE} [class*="block"]{--dsl-code-block-border-radius:${BLOCK_RADIUS}}`,
].join('')

let injected = false

/** Attach the sheet once per page. */
export function ensureClaudeMarkdownTheme(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const element = document.createElement('style')
  element.dataset.dshClaudeMarkdownTheme = ''
  element.textContent = CLAUDE_MARKDOWN_THEME_CSS
  document.head.appendChild(element)
}
