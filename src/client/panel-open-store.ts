/** Live "this plugin panel is on screen, and for which session" flag.
 *
 *  The details registration itself is plain plugin state owned by the client
 *  entry, but a Session-header action needs to render a pressed state from it,
 *  so the flag is published through a snapshot source instead: one store, one
 *  writer, `useSyncExternalStore` on the reading end. One instance per panel
 *  that owns a header toggle — the diff and the plan each have their own.
 *
 *  The maximized overlay keeps the registration mounted, so a diff that moves
 *  between the details column and the overlay stays open throughout. */
export interface PanelOpenSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
}

export class PanelOpenStore {
  #sessionId: string | undefined
  readonly #listeners = new Set<() => void>()

  /** Mark this panel open for one session, replacing any previous holder. */
  open(sessionId: string): void {
    this.#set(sessionId)
  }

  /** Mark this panel closed. */
  close(): void {
    this.#set(undefined)
  }

  /** Whether this panel is currently open for this session. */
  isOpen(sessionId: string): boolean {
    return this.#sessionId === sessionId
  }

  /** A per-session snapshot source for `useSyncExternalStore`. */
  sourceFor(sessionId: string): PanelOpenSource {
    return {
      subscribe: listener => {
        this.#listeners.add(listener)
        return () => {
          this.#listeners.delete(listener)
        }
      },
      getSnapshot: () => this.isOpen(sessionId),
    }
  }

  #set(sessionId: string | undefined): void {
    if (this.#sessionId === sessionId) return
    this.#sessionId = sessionId
    for (const listener of this.#listeners) listener()
  }
}
