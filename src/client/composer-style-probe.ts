import { CLAUDE_COMPOSER_BAR_ATTRIBUTE, claudeScopedCssFindings } from './boot-check.ts'

/** Watch for the plugin's composer bar and check it once for style drift.
 *
 *  The Host publishes the composer layout properties onto the composer subtree,
 *  not onto `:root`. Custom properties inherit, so only an element inside that
 *  subtree can read one — probing the document root reports every one of them
 *  missing whether or not the Host still defines it, which is exactly the
 *  false alarm this replaced.
 *
 *  The bar exists only while a Session is on screen, so this waits rather than
 *  sampling once at boot, and stops after the first successful read: the answer
 *  cannot change without a Host reload.
 *
 *  @param report - receives one line per property the bar cannot see.
 *  @returns disposer; safe to call more than once.
 */
export function watchClaudeComposerBar(report: (finding: string) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let observer: MutationObserver | undefined
  const stop = (): void => {
    observer?.disconnect()
    observer = undefined
  }
  const probe = (): boolean => {
    const bar = document.querySelector<HTMLElement>(`[${CLAUDE_COMPOSER_BAR_ATTRIBUTE}]`)
    if (bar === null) return false
    const style = getComputedStyle(bar)
    for (const finding of claudeScopedCssFindings(name => style.getPropertyValue(name))) report(finding)
    return true
  }
  if (probe()) return stop
  observer = new MutationObserver(() => {
    if (probe()) stop()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return stop
}
