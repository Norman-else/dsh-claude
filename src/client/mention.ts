/** `@` completion for the review reply composer.
 *
 *  GitHub resolves `@login` server-side, so completion is convenience only:
 *  every function here works on the draft text, never on the network. */

/** GitHub logins are alphanumeric with dashes; app accounts add a `[bot]`
 *  suffix, which the user reaches by continuing to type rather than by us
 *  matching it here. */
const HANDLE = /(?:^|[^\w@/-])@([\w-]*)$/u
const MAX_HANDLE_CHARS = 39

export interface MentionQuery {
  /** What the user has typed after the `@`, possibly empty. */
  readonly query: string
  /** Index of the `@` itself, where the completed login replaces the draft. */
  readonly start: number
}

/** The handle the caret is currently inside, when it is inside one. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | undefined {
  const before = text.slice(0, caret)
  const match = HANDLE.exec(before)
  const query = match?.[1]
  if (match === undefined || match === null || query === undefined || query.length > MAX_HANDLE_CHARS) return undefined
  return { query, start: caret - query.length - 1 }
}

/** Swap the typed handle for the chosen login, leaving a separating space. */
export function applyMention(text: string, caret: number, mention: MentionQuery, login: string): { text: string; caret: number } {
  const completed = `@${login} `
  return {
    text: `${text.slice(0, mention.start)}${completed}${text.slice(caret)}`,
    caret: mention.start + completed.length,
  }
}
