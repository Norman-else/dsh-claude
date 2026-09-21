import { DEFAULT_CLAUDE_PROSE_MODE, type ClaudeProseMode } from '../constants.ts'

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
  // NOT Pierre's `editor.background`, and not Claude's flat UI surface either.
  // The Host never paints from this token — CodeBlock.module.css routes
  // `pre.shiki` to the block's own background with `!important` — so it only
  // names the DSH surface for consistency with what is actually drawn.
  ['--shiki-background', 'var(--dsw-alias-markdown-code-block)', 'DSH code-block surface'],
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
  ['--shiki-background', 'var(--dsw-alias-markdown-code-block)', 'DSH code-block surface'],
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

/** Prose colours for the body of a Claude answer.
 *
 *  These are NOT Pierre: the palette above exists to match Claude's desktop
 *  build inside code blocks, and Claude paints prose in plain body text. This
 *  block is a deliberate departure — headings, emphasis and links get their
 *  own hues so a long answer is scannable, the way a Markdown-highlighting
 *  editor shows it. Values are theme-independent by design (the same six read
 *  acceptably on both surfaces); split them if the light theme ever needs its
 *  own ramp. The two `code*` entries are the exception: they are a dark surface
 *  and are only applied under a dark body.
 *
 *  The inline-code entry REPLACES {@link CLAY} rather than sitting beside it:
 *  two colours on the same chip is not a choice a stylesheet can make. */
const PROSE = {
  heading: '#7C9EFF',
  bold: '#FFB454',
  italic: '#5BD6C0',
  inlineCode: '#FF7A93',
  listMarker: '#F2C94C',
  quote: '#9AA3B2',
  link: '#4DA3FF',
  codeBackground: '#0F1218',
  codeBorder: '#2E3546',
} as const

/** The inline-code chip fill: a neutral 4% wash (Claude's `--t1`), not a tint
 *  of the text colour. A clay-tinted fill reads as a coloured box around every
 *  identifier; the neutral one disappears into the surface and lets the text
 *  carry the accent, which is what the chip is for. */
const INLINE_FILL_DARK = 'hsl(0 0% 100% / .04)'
const INLINE_FILL_LIGHT = 'hsl(0 0% 4.3% / .04)'

/** Block corner radius (Claude's `--r6`), against the Host's own 12px. */
const BLOCK_RADIUS = '8px'

// The block's surface is deliberately NOT part of the palette: the Host paints
// it from `--dsw-alias-markdown-code-block` and `-banner`, which DSH resolves to
// adjacent steps of its neutral ramp per theme. Claude's desktop build replaces
// both with one flat colour, and restating that here made a dsh-claude block
// whiter than the page in light and lost the banner separation in dark. Leaving
// the aliases alone keeps the block native and tracks the Host's ramp. The
// syntax colours stay Claude's Pierre mapping.
function palette(entries: readonly (readonly [string, string, string])[], inlineFill: string): string {
  return [
    ...entries.map(([name, value]) => `${name}:${value};`),
    `--dsw-alias-markdown-inline-code:${inlineFill}`,
  ].join('')
}

/** The hairline drawn around a corrected block, on the ramp it sits in. */
const DSH_CODE_RING_LIGHT = '#e1e5ee'
const DSH_CODE_RING_DARK = '#353638'

export const CLAUDE_MARKDOWN_THEME_CSS = [
  `.${CLAUDE_MARKDOWN_SCOPE}{display:contents;`,
    palette(PIERRE_LIGHT, INLINE_FILL_LIGHT),
  '}',
  `body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE}{`,
    palette(PIERRE_DARK, INLINE_FILL_DARK),
  '}',
  // The Host's inline-code rule sets a background but no colour, so the chip
  // inherits body text. Claude's build tints it with the brand clay.
  // Claude's chip is tighter than the Host's 6px/0 5px.
  //
  // `!important` on the size is not a preference: the Host's own declaration
  // carries it (MarkdownText.module.css `font-size: 0.875em !important`), so
  // nothing weaker can reach it. 0.875em leaves a monospace chip visibly
  // shorter than the CJK body text beside it — the code font's x-height is
  // already lower at equal px, and the two shrinks compound. The `em` resolves
  // against the PARENT, so against a 14px body the Host's rule lands at
  // 12.25px; 1.05em lands at 14.7px, which is where a monospace chip stops
  // reading as smaller than the prose it sits in. Anything under 1em is inside
  // the noise of antialiasing here and looks unchanged. This sits in the BASE
  // sheet, not the enhanced one: legibility is not part of the palette a
  // reader opts into.
  `.${CLAUDE_MARKDOWN_SCOPE} :not(pre)>code{color:${CLAY_EMPHASIZED};border-radius:4px;padding:1px 2px;font-size:1.05em!important}`,
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
  // The Host rounds only the BOTTOM of `<pre>`; the top radii live on the banner
  // bar. With the bar lifted out of flow above, `<pre>` is the block's first
  // box and its opaque square top paints over the wrapper's rounded corners.
  `.${CLAUDE_MARKDOWN_SCOPE} [class*="block"] pre{border-radius:var(--dsl-code-block-border-radius)}`,
  // The hairline. `bannerWrap` is the one local name unique to CodeBlock — the
  // other block primitives (DiffBlock, TerminalBlock, ReadBlock, SearchBlock)
  // all emit a local named `block` too, so a bare [class*="block"] would draw
  // this ring around a tool result's diff or terminal as well. Requiring the
  // block to CONTAIN a bannerWrap picks out only the real code block. A ring,
  // not a border, because a border would add layout the sticky banner fights.
  `.${CLAUDE_MARKDOWN_SCOPE} [class*="block"]:has([class*="bannerWrap"]){box-shadow:0 0 0 1px ${DSH_CODE_RING_LIGHT}}`,
  `body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE} [class*="block"]:has([class*="bannerWrap"]){box-shadow:0 0 0 1px ${DSH_CODE_RING_DARK}}`,

].join('')

/** The class the review-comment card puts on a rendered comment body. Declared
 *  here rather than imported because it is a literal inside `styles.ts`'s CSS
 *  string, not a constant; a rename there makes these rules miss and the
 *  comment keeps its stock colours, which is the same fail-open the chrome
 *  rules above rely on. */
const COMMENT_BODY_SCOPE = 'dshClaudeDiffCommentBody'

/** Everything the `prose: 'enhanced'` setting adds, and nothing the base sheet
 *  needs. Appended AFTER the base sheet so its rules win ties on source order —
 *  see the note on the inline-code selector below. */
export const CLAUDE_MARKDOWN_ENHANCED_CSS = [
  // Last in the sheet on purpose: every rule here has to win against an
  // earlier one at EQUAL specificity, so source order is the tie-break. The
  // inline-code entry repeats the clay rules' two selectors verbatim for that
  // reason — the dark-theme one carries an extra attribute selector, and a
  // single flat `.scope :not(pre)>code` would lose to it under a dark body.
  `.${CLAUDE_MARKDOWN_SCOPE} :is(h1,h2,h3,h4,h5,h6){color:${PROSE.heading}}`,
  `.${CLAUDE_MARKDOWN_SCOPE} strong{color:${PROSE.bold}}`,
  `.${CLAUDE_MARKDOWN_SCOPE} em{color:${PROSE.italic}}`,
  `.${CLAUDE_MARKDOWN_SCOPE} li::marker{color:${PROSE.listMarker}}`,
  `.${CLAUDE_MARKDOWN_SCOPE} blockquote{border-left-color:${PROSE.quote};color:${PROSE.quote}}`,
  `.${CLAUDE_MARKDOWN_SCOPE} a{color:${PROSE.link}}`,
  `.${CLAUDE_MARKDOWN_SCOPE} :not(pre)>code,body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE} :not(pre)>code{color:${PROSE.inlineCode}}`,

  // The darker, outlined code surface the highlight palette is drawn against —
  // DARK THEME ONLY. The syntax palette follows the theme (Pierre Light under a
  // light body), so a near-black block in light mode is both the loudest thing
  // on the page and the wrong ground for its own tokens; there the base sheet's
  // DSH surface and ring stay.
  //
  // The selector mirrors the base sheet's dark ring rule exactly, so the two
  // TIE in specificity and this one wins on source order.
  `body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE} [class*="block"]:has([class*="bannerWrap"]){background:${PROSE.codeBackground};box-shadow:0 0 0 1px ${PROSE.codeBorder}}`,
  `body[data-ds-dark-theme] .${CLAUDE_MARKDOWN_SCOPE} pre{background:${PROSE.codeBackground}}`,

  // GitHub review comments never pass through MarkdownText — `comment-markdown.ts`
  // renders them and the card owns their typography — so the same palette has
  // to be spelled a second time against that scope.
  `.${COMMENT_BODY_SCOPE} :is(h1,h2,h3,h4,h5,h6){color:${PROSE.heading}}`,
  `.${COMMENT_BODY_SCOPE} strong{color:${PROSE.bold}}`,
  `.${COMMENT_BODY_SCOPE} em{color:${PROSE.italic}}`,
  `.${COMMENT_BODY_SCOPE} li::marker{color:${PROSE.listMarker}}`,
  `.${COMMENT_BODY_SCOPE} blockquote{border-left-color:${PROSE.quote};color:${PROSE.quote}}`,
  `.${COMMENT_BODY_SCOPE} a{color:${PROSE.link}}`,
  `.${COMMENT_BODY_SCOPE} :not(pre)>code{color:${PROSE.inlineCode}}`,
].join('')

/** Live reference to this package's sheet, and the mode it currently holds.
 *  The mode is remembered so `ensureClaudeMarkdownTheme` — called on every
 *  Markdown render — cannot undo a choice boot or the settings panel made. */
let styleTag: HTMLStyleElement | null = null
let mode: ClaudeProseMode = DEFAULT_CLAUDE_PROSE_MODE

function write(): void {
  if (typeof document === 'undefined') return
  if (styleTag === null || styleTag.parentNode === null) {
    styleTag = document.createElement('style')
    styleTag.dataset.dshClaudeMarkdownTheme = ''
    document.head.appendChild(styleTag)
  }
  styleTag.textContent = mode === 'enhanced'
    ? CLAUDE_MARKDOWN_THEME_CSS + CLAUDE_MARKDOWN_ENHANCED_CSS
    : CLAUDE_MARKDOWN_THEME_CSS
}

/** Attach the sheet, keeping whatever mode is already set. Idempotent. */
export function ensureClaudeMarkdownTheme(): void {
  write()
}

/** Switch the prose palette. Rewriting one global sheet repaints every mounted
 *  Markdown block at once, so no render state has to carry the setting. */
export function applyClaudeMarkdownTheme(next: ClaudeProseMode): void {
  mode = next
  write()
}
