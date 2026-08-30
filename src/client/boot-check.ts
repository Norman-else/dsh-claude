/** Boot-time assertions against the running Host.
 *
 *  The Desktop build ships no type declarations and several of its client
 *  packages are unpublished, so `tsc` validates this plugin against whatever
 *  @deepseek-ai/* versions happen to be installed — never against the Host it
 *  will actually run inside. Every Desktop 2.0 breakage found so far was
 *  invisible at compile time AND at runtime: a missing service leaves its
 *  guarded registration silently unregistered, and a renamed custom property
 *  just freezes a style on its fallback. These checks make that drift say so. */

/** Host-owned custom properties the styles read, and where each is scoped.
 *
 *  `var(--x, fallback)` cannot distinguish "the Host stopped publishing this"
 *  from "the Host says this", so anything listed here needs an explicit probe.
 *  The Host scopes these to a subtree rather than `:root` — custom properties
 *  inherit, so only an element inside that subtree can see one, and probing
 *  document.documentElement reports every one of them missing. Each entry
 *  therefore names the mounted element that must be measured instead.
 *
 *  Plugin-owned properties (--dsh-claude-*) are set by this package and are
 *  deliberately absent from this list. */
export const CLAUDE_SCOPED_CSS_VARIABLES: readonly string[] = [
  // Caps the repository and review-comment bars; the Host republishes it on the
  // composer subtree as the conversation divider is dragged.
  '--dsh-composer-card-max-width',
]

/** Marks the bar the scoped-property probe measures. */
export const CLAUDE_COMPOSER_BAR_ATTRIBUTE = 'data-dsh-claude-composer-bar'

export interface ClaudeBootCheckInput {
  /** Service names the plugin declares in `export const inject`. */
  services: readonly string[]
  resolve(name: string): unknown
}

/** One line per service the Host no longer provides; empty when all resolve. */
export function claudeBootCheckFindings(input: ClaudeBootCheckInput): string[] {
  const findings: string[] = []
  for (const name of input.services) {
    if (input.resolve(name) === undefined) {
      findings.push(`service "${name}" is declared in inject but the Host does not provide it`)
    }
  }
  return findings
}

/** One line per scoped custom property the measured element cannot see.
 *
 *  @param read - computed value of one property ON THE MOUNTED BAR, not on the
 *  document root: these properties are published to a subtree, so reading them
 *  anywhere above it returns '' whether or not the Host still defines them. */
export function claudeScopedCssFindings(
  read: (name: string) => string,
  names: readonly string[] = CLAUDE_SCOPED_CSS_VARIABLES,
): string[] {
  const findings: string[] = []
  for (const name of names) {
    if (read(name).trim() === '') {
      findings.push(`CSS custom property "${name}" is not visible to the composer bar; styles reading it are stuck on their fallback`)
    }
  }
  return findings
}
