/** Answer DSH's auxiliary session-title request with a throwaway Haiku turn.
 *
 *  DSH titles a session by asking the model behind the session's own route for
 *  a summary of the first human message. That route is this plugin, and the
 *  session's Claude process must not answer it: the title call carries a
 *  plugin-authored system prompt and would land in the user's transcript. A
 *  separate one-shot turn keeps it out, for the same reasons as the branch-name
 *  summary and the plan-usage probe. Deployments that never installed a second
 *  model provider still get a readable title, since the only model this plugin
 *  needs is the one it already runs. */
import { query as claudeQuery, type Options as ClaudeOptions, type Query } from '@anthropic-ai/claude-agent-sdk'

/** Cheapest model that can summarize a sentence in the language it was written in. */
export const SESSION_TITLE_MODEL = 'haiku'

/** Backstop only. The title service wraps its own deadline (60s by default)
 *  around the call and passes it as `signal`, so a shorter budget here just
 *  kills a turn the caller was still happy to wait for — a cold CLI start plus
 *  one Haiku reply routinely passes ten seconds. */
export const SESSION_TITLE_TIMEOUT_MS = 60_000

/** DSH frames the messages as JSON under its own byte cap; this only bounds a
 *  caller that does not. */
const MAX_INPUT_CHARS = 8_000
/** Longer than any title DSH accepts (80 bytes), short enough to bound prose. */
const MAX_TITLE_CHARS = 200

export interface SessionTitleRequest {
  /** DSH's own title instruction, including its target length and language rule. */
  readonly system?: string
  /** The framed human messages to title. */
  readonly input: string
  /** Cancellation from the title service when a newer revision supersedes this one. */
  readonly signal?: AbortSignal
}

/** Carry DSH's instruction as the prompt's own preamble: a Claude Code turn has
 *  no separate system slot this plugin can borrow without replacing the CLI's. */
export function sessionTitlePrompt(request: SessionTitleRequest): string {
  const input = request.input.trim().slice(0, MAX_INPUT_CHARS)
  return request.system === undefined || request.system.length === 0
    ? input
    : `${request.system}\n\n${input}`
}

/** The one line of the reply that is the title. DSH strips control characters
 *  and truncates to its own byte cap, so nothing else is cleaned here. */
export function sessionTitleLine(reply: string): string {
  const line = reply.split('\n').map(candidate => candidate.trim()).find(candidate => candidate.length > 0)
  return line === undefined ? '' : line.slice(0, MAX_TITLE_CHARS)
}

/**
 * Summarize the framed messages into one title line.
 *
 * Rejects rather than returning a placeholder: the title service logs the
 * failure and keeps the deterministic first-words fallback, which is a better
 * label than anything this function could invent.
 */
export async function summarizeSessionTitle(
  executablePath: string,
  request: SessionTitleRequest,
  factory: (params: { prompt: string; options: ClaudeOptions }) => Query = claudeQuery,
): Promise<string> {
  const prompt = sessionTitlePrompt(request)
  if (prompt.length === 0) throw new Error('dsh-claude: the session-title request carried no text')
  const lifetime = new AbortController()
  const abort = (): void => { lifetime.abort() }
  request.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, SESSION_TITLE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const query = factory({
      prompt,
      options: {
        cwd: process.cwd(),
        abortController: lifetime,
        model: SESSION_TITLE_MODEL,
        allowedTools: [],
        // Isolated from filesystem settings on purpose: a CLAUDE.md instruction
        // aimed at the coding session ("always answer in English", "start every
        // reply with a checklist") would be answering the wrong question here.
        settingSources: [],
        maxTurns: 1,
        ...(executablePath.length === 0 ? {} : { pathToClaudeCodeExecutable: executablePath }),
      },
    })
    for await (const message of query) {
      if (message.type !== 'result' || message.subtype !== 'success') continue
      const title = sessionTitleLine(message.result)
      if (title.length > 0) return title
      break
    }
    throw new Error('dsh-claude: the session-title turn produced no title')
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abort)
    lifetime.abort()
  }
}
