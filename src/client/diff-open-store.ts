/** Live "the plugin's diff panel is on screen, and for which session" flag.
 *
 *  The details registration itself is plain plugin state owned by the client
 *  entry, but the Session-header action needs to render a pressed state from
 *  it, so the flag is published through a snapshot source instead: one store,
 *  one writer, `useSyncExternalStore` on the reading end.
 *
 *  The maximized overlay keeps the registration mounted, so a diff that moves
 *  between the details column and the overlay stays open throughout. */
export interface DiffOpenSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
}

export class DiffOpenStore {
  #sessionId: string | undefined
  readonly #listeners = new Set<() => void>()

  /** Mark the diff panel open for one session, replacing any previous holder. */
  open(sessionId: string): void {
    this.#set(sessionId)
  }

  /** Mark the diff panel closed. */
  close(): void {
    this.#set(undefined)
  }

  /** Whether the diff panel is currently open for this session. */
  isOpen(sessionId: string): boolean {
    return this.#sessionId === sessionId
  }

  /** A per-session snapshot source for `useSyncExternalStore`. */
  sourceFor(sessionId: string): DiffOpenSource {
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
