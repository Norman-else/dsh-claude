/** Minimal session-list shape the on-screen lookup reads. */
export interface MainSessionList {
  readonly byId: Readonly<Record<string, { readonly retainedBy?: Readonly<Record<string, number | undefined>> } | undefined>>
}

/** The Session in the main view, or undefined on the blank screen.
 *
 *  Host 0.1.7 dropped `current` from the session list: the main view now holds
 *  its Session through a `mainView` retain, and the Host's own sidebar finds
 *  the on-screen Session the same way. */
export function mainSessionId(list: MainSessionList): string | undefined {
  for (const [id, row] of Object.entries(list.byId)) {
    if ((row?.retainedBy?.mainView ?? 0) > 0) return id
  }
  return undefined
}
