/** Name a generated worktree branch after what the user is about to ask for.
 *
 *  The composer draft is the only description of the work that exists before
 *  the session starts, and it is usually not English and never branch-safe, so
 *  a throwaway Haiku turn compresses it into a slug. Naming is a nicety: every
 *  failure here returns `undefined` and the caller keeps its timestamped name. */
import { query as claudeQuery, type Options as ClaudeOptions, type Query } from '@anthropic-ai/claude-agent-sdk'

/** Cheapest model that can translate and compress a sentence. */
export const BRANCH_SUMMARY_MODEL = 'haiku'

/** A branch name is not worth blocking worktree creation on for long. */
export const BRANCH_SUMMARY_TIMEOUT_MS = 15_000

const MAX_INTENT_CHARS = 2_000
/** A compliant reply is one short fragment; anything longer is prose. */
const MAX_REPLY_CHARS = 80
/** More words than this is a sentence, not the fragment we asked for. */
const MAX_SLUG_WORDS = 6
const MAX_SLUG_CHARS = 48

export function branchSummaryPrompt(intent: string): string {
  return [
    'Summarize this software task as a Git branch name fragment.',
    'Reply with 2-5 lowercase English words joined by hyphens and nothing else:',
    'no quotes, no slashes, no prefix, no punctuation, no explanation.',
    'Translate the task to English if it is written in another language.',
    '',
    'Task:',
    `"""\n${intent.replaceAll('"""', '" " "')}\n"""`,
  ].join('\n')
}

/** Branch-safe slug for a model reply, or `undefined` when the reply is not
 *  the fragment we asked for. Mangling a refusal or a paragraph into a slug
 *  would produce a worse name than the timestamped fallback. */
export function branchSlug(reply: string): string | undefined {
  const line = reply.trim()
  if (line.length === 0 || line.length > MAX_REPLY_CHARS || /[\r\n]/u.test(line)) return undefined
  const words = line.toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .split('-')
    .filter(word => word.length > 0)
  if (words.length === 0 || words.length > MAX_SLUG_WORDS) return undefined
  // ponytail: a long fragment is cut mid-word; six short words almost never
  // reach 48 characters, and a branch name is allowed to be blunt.
  const slug = words.join('-').slice(0, MAX_SLUG_CHARS).replace(/-+$/u, '')
  return slug.length === 0 ? undefined : slug
}

/** First free name in `<candidate>`, `<candidate>-2`, `<candidate>-3`, … */
export function uniqueBranchName(candidate: string, taken: readonly string[]): string {
  const existing = new Set(taken)
  if (!existing.has(candidate)) return candidate
  for (let index = 2; index < 100; index += 1) {
    const name = `${candidate}-${index}`
    if (!existing.has(name)) return name
  }
  return candidate
}

/** Compress a composer draft into a branch slug with a throwaway Claude turn.
 *
 *  Deliberately NOT routed through the supervisor, for the same reasons as the
 *  plan-usage probe: there is no session to borrow yet. The turn is isolated
 *  from filesystem settings as well, because a CLAUDE.md instruction ("always
 *  reply in the user's language") turns the answer into an unusable slug. */
export async function summarizeBranchSlug(
  executablePath: string,
  intent: string,
  factory: (params: { prompt: string; options: ClaudeOptions }) => Query = claudeQuery,
): Promise<string | undefined> {
  const task = intent.trim().slice(0, MAX_INTENT_CHARS)
  if (task.length === 0) return undefined
  const lifetime = new AbortController()
  const timer = setTimeout(() => lifetime.abort(), BRANCH_SUMMARY_TIMEOUT_MS)
  timer.unref?.()
  try {
    const query = factory({
      prompt: branchSummaryPrompt(task),
      options: {
        cwd: process.cwd(),
        abortController: lifetime,
        model: BRANCH_SUMMARY_MODEL,
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        ...(executablePath.length === 0 ? {} : { pathToClaudeCodeExecutable: executablePath }),
      },
    })
    for await (const message of query) {
      if (message.type === 'result' && message.subtype === 'success') return branchSlug(message.result)
    }
    return undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    lifetime.abort()
  }
}
