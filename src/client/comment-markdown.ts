/** GitHub review comments get their own renderer.
 *
 *  The Host's Markdown component renders untrusted model output, so it
 *  disables raw HTML by contract — and review bots write HTML: `<sup>`
 *  footers, `<details>` disclosures, `<img>` badges. Rendered through that
 *  component those tags arrive as literal text. A pull request comment is a
 *  different kind of document with a different threat model: it comes from
 *  GitHub, and rendering it the way GitHub does means parsing GFM and keeping
 *  a bounded set of HTML — which is what this module does, against an
 *  allowlist, with everything else dropped by the sanitizer. */
import DOMPurify from 'dompurify'
import { Marked } from 'marked'

/** Tags GitHub itself permits that carry meaning in a review comment.
 *  Everything outside this list — scripts, styles, iframes, forms, event
 *  handlers — is removed rather than escaped. */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'b', 'i', 'del', 's', 'ins', 'mark', 'small', 'sup', 'sub', 'kbd',
  'a', 'img',
  'ul', 'ol', 'li', 'input',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'details', 'summary',
]

const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'align', 'colspan', 'rowspan', 'start', 'type', 'checked', 'disabled', 'open', 'class']

// GitHub's comment fields render a single newline as a line break, so a bot's
// `**Low Severity**` heading line stays on its own line here too.
const marked = new Marked({ gfm: true, breaks: true, async: false })

/** Parse one comment body into HTML. Bot machinery written as HTML comments
 *  disappears here: the sanitizer strips comment nodes, and this drops the
 *  blank runs they leave behind so the prose keeps its spacing. */
export function commentBodyHtml(body: string): string {
  const source = body
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/[^\S\n]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return marked.parse(source) as string
}

/** Sanitize parsed comment HTML against the allowlist and make every link
 *  leave the app safely. Returns '' where no DOM exists (server rendering),
 *  because unsanitized HTML must never reach the caller. */
export function sanitizeCommentHtml(html: string, purify: typeof DOMPurify = DOMPurify): string {
  if (typeof purify.sanitize !== 'function' || purify.isSupported !== true) return ''
  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    // Task-list checkboxes render, but nothing in a comment may be operated.
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'form'],
    ADD_ATTR: ['target', 'rel'],
  })
}

/** One review comment body, ready for `dangerouslySetInnerHTML`. */
export function renderCommentBody(body: string, purify: typeof DOMPurify = DOMPurify): string {
  return sanitizeCommentHtml(commentBodyHtml(body), purify)
}

/** Open sanitized links in the browser instead of inside the app shell, and
 *  keep comment checkboxes inert. Installed once, on import, so no render
 *  path can reach the sanitizer before its hooks. */
export function installCommentSanitizerHooks(purify: typeof DOMPurify = DOMPurify): void {
  if (typeof purify.addHook !== 'function' || purify.isSupported !== true) return
  purify.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.nodeName === 'INPUT') node.setAttribute('disabled', '')
  })
}

installCommentSanitizerHooks()
