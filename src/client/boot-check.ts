/** Boot-time assertions against the running Host.
 *
 *  The Desktop build ships no type declarations and several of its client
 *  packages are unpublished, so `tsc` validates this plugin against whatever
 *  @deepseek-ai/* versions happen to be installed — never against the Host it
 *  will actually run inside. Every Desktop 2.0 breakage found so far was
 *  invisible at compile time AND at runtime: a missing service leaves its
 *  guarded registration silently unregistered, and a renamed custom property
 *  just freezes a style on its fallback. These checks make that drift say so. */

/** Host-owned custom properties the styles read.
 *
 *  `var(--x, fallback)` cannot distinguish "the Host stopped publishing this"
 *  from "the Host says this", so anything listed here needs an explicit probe.
 *  Plugin-owned properties (--dsh-claude-*) are set by this package and are
 *  deliberately absent. */
export const CLAUDE_REQUIRED_CSS_VARIABLES: readonly string[] = [
  // Drives the width of the repository and review-comment bars; the Host
  // republishes it as the conversation divider is dragged.
  '--dsh-composer-card-max-width',
]

export interface ClaudeBootCheckInput {
  /** Service names the plugin declares in `export const inject`. */
  services: readonly string[]
  resolve(name: string): unknown
  cssVariables: readonly string[]
  /** Computed value of one custom property; '' when the Host defines none. */
  readCssVariable(name: string): string
}

/** One human-readable line per broken assumption; empty when the Host matches. */
export function claudeBootCheckFindings(input: ClaudeBootCheckInput): string[] {
  const findings: string[] = []
  for (const name of input.services) {
    if (input.resolve(name) === undefined) {
      findings.push(`service "${name}" is declared in inject but the Host does not provide it`)
    }
  }
  for (const name of input.cssVariables) {
    if (input.readCssVariable(name).trim() === '') {
      findings.push(`CSS custom property "${name}" is not defined by the Host; styles reading it are stuck on their fallback`)
    }
  }
  return findings
}
