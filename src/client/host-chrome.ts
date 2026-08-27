/** Host chrome this plugin suppresses from the browser side.
 *
 *  The `Session log` capsule in the Session header is contributed by
 *  `@deepseek-ai/dsh-session-log-export` into
 *  `conversation.session.header.utilities`. Shadowing that slot entry would
 *  also take its download-progress dialog down with it, so the capsule is
 *  hidden with CSS instead: the download controller, its dialog, and the
 *  `/export` slash command all keep working.
 *
 *  The selector matches the CSS Module local name rather than the emitted
 *  class: only the build-hash prefix changes across Host releases. A rename of
 *  the local name degrades to a no-op (the capsule reappears) instead of
 *  breaking the header.
 */
const HOST_CHROME_CSS = 'button[class*="sessionLogButton"]{display:none}'

/** Install the suppression stylesheet.
 *  @returns a disposer that removes it again. */
export function suppressHostChrome(): () => void {
  if (typeof document === 'undefined') return () => {}
  const element = document.createElement('style')
  element.dataset.dshClaudeHostChrome = ''
  element.textContent = HOST_CHROME_CSS
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}
