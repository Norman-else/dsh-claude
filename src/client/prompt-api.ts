import { CLAUDE_PROMPTS_PATH, CLAUDE_PROMPT_NAME_PATH, CLAUDE_PROMPT_REFINE_PATH } from '../constants.ts'
import type { ClaudePromptView } from '../prompts.ts'
import { pluginRead, pluginWrite } from './plugin-transport.ts'

/** Prompt files live in one global directory, so one module-level cache serves
 *  every session. The TTL is what lets a file added outside DSH appear without
 *  a reload, while a burst of keystrokes through the menu still costs one
 *  directory scan. */
const TTL_MS = 5_000

let cached: { at: number; prompts: Promise<readonly ClaudePromptView[]> } | undefined

export function invalidateClaudePrompts(): void {
  cached = undefined
}

/** The user's prompt snippets, at most one read per TTL window. */
export async function claudePrompts(): Promise<readonly ClaudePromptView[]> {
  const at = Date.now()
  if (cached !== undefined && at - cached.at < TTL_MS) return await cached.prompts
  const prompts = pluginRead<{ prompts: readonly ClaudePromptView[] }>(CLAUDE_PROMPTS_PATH, 'fast')
    .then(payload => payload.prompts)
    .catch(() => {
      // A failed read must not pin an empty menu for the rest of the window.
      invalidateClaudePrompts()
      return []
    })
  cached = { at, prompts }
  return await prompts
}

/** Save one snippet, answering where it landed. Rejects with a
 *  `PluginRequestError` whose `code` is `name-taken` when the file already
 *  exists; nothing is overwritten. */
export async function saveClaudePrompt(name: string, body: string): Promise<ClaudePromptView> {
  const saved = await pluginWrite<{ prompt: ClaudePromptView }>(CLAUDE_PROMPTS_PATH, 'fast', undefined, { json: { name, body } })
  invalidateClaudePrompts()
  return saved.prompt
}

/** Ask the host to name a draft with Claude's cheapest model. Answers
 *  undefined whenever no name could be had — the caller already holds the
 *  locally derived one, so a failure here is never worth reporting. */
export async function suggestClaudePromptName(draft: string, cancel?: AbortSignal): Promise<string | undefined> {
  try {
    const answer = await pluginWrite<{ name?: string }>(CLAUDE_PROMPT_NAME_PATH, 'git', cancel, { json: { draft } })
    return answer.name
  } catch {
    return undefined
  }
}

/** Rewrite a draft into something an agent can act on. Unlike the name
 *  suggestion this one throws: the user asked for it and is waiting, so a
 *  failure is theirs to see rather than ours to swallow. */
export async function refineClaudePrompt(draft: string, cancel?: AbortSignal): Promise<string> {
  const answer = await pluginWrite<{ text: string }>(CLAUDE_PROMPT_REFINE_PATH, 'git', cancel, { json: { draft } })
  return answer.text
}

/** Characters the host's `PROMPT_NAME` guard rejects; scrubbed rather than
 *  re-implemented here, so a drift in the guard cannot let a bad name through
 *  (the host still validates, and answers `invalid-name`). */
const FOREIGN_NAME_CHARS = /[^\p{L}\p{M}\p{N} ._()\[\]-]/gu
const MAX_NAME_CHARS = 40

function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** The file name to offer for a draft: its opening line, scrubbed to what a
 *  file name may hold. A draft that opens with punctuation or an emoji leaves
 *  nothing usable, so those fall back to a timestamp the user can rename. */
export function defaultPromptName(draft: string, now: Date = new Date()): string {
  const opening = draft.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? ''
  const collapsed = opening.replace(FOREIGN_NAME_CHARS, ' ').replace(/\s+/gu, ' ').trim()
  // Cut at a word boundary, not mid-word: this name is a suggestion the user
  // may well accept as typed.
  const cut = collapsed.slice(0, MAX_NAME_CHARS)
  const boundary = collapsed.length > MAX_NAME_CHARS ? cut.search(/[\s\-_][^\s\-_]*$/u) : -1
  const scrubbed = (boundary > 0 ? cut.slice(0, boundary) : cut).trim()
  return /^[\p{L}\p{N}]/u.test(scrubbed) ? scrubbed : `prompt-${stamp(now)}`
}
