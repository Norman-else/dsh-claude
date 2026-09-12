/** Which extra checkout roots a session's routes may act on.
 *
 *  A session's linked repositories are re-derived on every projection sweep,
 *  and any one sweep's git/gh probes can transiently fail -- dropping a
 *  checkout the client is still showing a bar for. Replacing the authorised
 *  set each sweep would then 409 that bar's controls until the next good
 *  sweep, which reads as a control that silently does nothing. A session only
 *  ever gains checkouts it has genuinely written into, so the ledger only
 *  grows within a session's lifetime and never un-vouches a root a later
 *  probe happened to miss. Bounded so a long session cannot grow it forever. */
export class SessionRootLedger {
  readonly #roots = new Map<string, Set<string>>()
  readonly #max: number

  constructor(max: number) {
    this.#max = max
  }

  /** Add the roots this sweep vouched for; existing ones stay. */
  vouch(sessionId: string, roots: readonly string[]): void {
    let set = this.#roots.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.#roots.set(sessionId, set)
    }
    for (const root of roots) {
      // Re-insert to make it the most-recent, so the cap drops stale roots first.
      set.delete(root)
      set.add(root)
      if (set.size > this.#max) set.delete(set.values().next().value as string)
    }
  }

  allows(sessionId: string, root: string): boolean {
    return this.#roots.get(sessionId)?.has(root) === true
  }

  forget(sessionId: string): void {
    this.#roots.delete(sessionId)
  }
}
