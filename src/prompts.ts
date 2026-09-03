import { homedir } from 'node:os'
import { mkdir, opendir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { CLAUDE_PROMPTS_PATH, CLAUDE_PROMPT_NAME_PATH } from './constants.ts'
import { redactText } from './events.ts'
import { registerPluginRoute } from './http.ts'

/** One prompt file as the composer menu sees it: the file name is the menu
 *  row, the body is what lands in the composer verbatim. */
export interface ClaudePromptView {
  name: string
  description: string
  body: string
  /** Where the file sits, written for a human to read rather than to open:
   *  the home directory collapses to `~`, so the confirmation that a prompt
   *  was saved can name the file without spilling the whole absolute path. */
  location: string
}

const MAX_PROMPT_FILES = 256
const MAX_PROMPT_BYTES = 16 * 1024
const MAX_DESCRIPTION_CHARS = 120
const MAX_REQUEST_BYTES = 32 * 1024

/**
 * The same shape as the output-style name in `global-settings.ts`, plus
 * `\p{M}` so a macOS-decomposed name survives. Two properties matter and both
 * are load-bearing: no member of the class is a path separator, and the first
 * character can be neither a dot nor a separator — so `join(dir, name + '.md')`
 * cannot address anything outside `dir`. Nothing else validates the path.
 */
const PROMPT_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._()\[\]-]{0,127}$/u

/** Prompt snippets live beside the rest of the user's Claude Code state. */
export function claudePromptsDir(): string {
  return join(homedir(), '.claude', 'prompts')
}

/** `~/.claude/prompts/x.md` rather than the absolute path it expands to. */
export function displayPath(file: string): string {
  const home = homedir()
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

/** The menu's second row: the first non-empty line, collapsed and bounded. */
function summarize(body: string): string {
  const line = body.split('\n').map(text => text.trim()).find(text => text.length > 0) ?? ''
  return redactText(line.replace(/\s+/gu, ' '), MAX_DESCRIPTION_CHARS)
}

/**
 * Every `.md` file in the prompts directory, sorted by name.
 *
 * A missing directory is the ordinary state before the user saves anything,
 * and one unreadable file must not empty the whole menu — both answer with
 * what is there rather than throwing.
 */
export async function readClaudePrompts(directory: string): Promise<readonly ClaudePromptView[]> {
  const prompts: ClaudePromptView[] = []
  let entries
  try {
    entries = await opendir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return prompts
    throw error
  }
  for await (const entry of entries) {
    if (prompts.length >= MAX_PROMPT_FILES) break
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
    const name = entry.name.slice(0, -3)
    if (!PROMPT_NAME.test(name)) continue
    try {
      const file = join(directory, entry.name)
      const body = await readFile(file, 'utf8')
      if (body.trim().length === 0 || Buffer.byteLength(body) > MAX_PROMPT_BYTES) continue
      prompts.push({ name, description: summarize(body), body, location: displayPath(file) })
    } catch {
      // Ignore unreadable prompt files.
    }
  }
  return prompts.sort((left, right) => left.name.localeCompare(right.name))
}

export type ClaudePromptWriteCode = 'invalid-name' | 'invalid-body' | 'name-taken'

export class ClaudePromptWriteError extends Error {
  readonly code: ClaudePromptWriteCode

  constructor(code: ClaudePromptWriteCode, message: string) {
    super(message)
    this.name = 'ClaudePromptWriteError'
    this.code = code
  }
}

/**
 * Save one prompt, refusing to clobber an existing file.
 *
 * `wx` is the whole collision policy: a name the user already uses is theirs
 * to resolve, and overwriting a prompt they keep is not something they can
 * undo from inside DSH.
 */
export async function writeClaudePrompt(directory: string, name: unknown, body: unknown): Promise<ClaudePromptView> {
  if (typeof name !== 'string' || !PROMPT_NAME.test(name)) {
    throw new ClaudePromptWriteError('invalid-name', 'The prompt name is invalid.')
  }
  if (typeof body !== 'string' || body.trim().length === 0 || Buffer.byteLength(body) > MAX_PROMPT_BYTES) {
    throw new ClaudePromptWriteError('invalid-body', 'The prompt text is empty or too large.')
  }
  const text = body.endsWith('\n') ? body : `${body}\n`
  const file = join(directory, `${name}.md`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ClaudePromptWriteError('name-taken', 'A prompt with that name already exists.')
    }
    throw error
  }
  return { name, description: summarize(text), body: text, location: displayPath(file) }
}


const MAX_NAME_DRAFT_CHARS = 4_000
const MAX_NAME_OUTPUT_BYTES = 4 * 1024
const MAX_SUGGESTED_NAME_CHARS = 48
const NAME_TIMEOUT_MS = 40_000

/**
 * Ask for a file name and nothing else, with the draft fenced as data.
 *
 * Two things here were measured rather than guessed. The instruction travels
 * in the user turn, not in `--system-prompt`: a saved prompt is itself an
 * instruction and a system prompt does not outrank it, so the model reads the
 * draft as its task and answers it instead of naming it. And the default
 * system prompt is left in place even though it is large, because the CLI
 * sends it as a cache read (~6.5k cached tokens); replacing it with a short
 * one costs a fresh 3.5k-token prefill and measured slower end to end.
 *
 * The naming spec is this specific because a vaguer one ("describe what the
 * template does, at most 40 characters") produced names that were both
 * inconsistent in style and stripped of the detail that tells two similar
 * templates apart.
 */
export function promptNamePrompt(draft: string): string {
  const text = draft.trim().slice(0, MAX_NAME_DRAFT_CHARS)
  return [
    'Below is a reusable prompt template a user is saving to a file. Name it.',
    '',
    `"""\n${text.replaceAll('"""', '" " "')}\n"""`,
    '',
    'Answer with the file name alone: no quotes, no explanation, no extension, no leading dot, no slashes.',
    'Write it in English however the template is written, as lower-case words joined by hyphens.',
    'Name the task the template performs, keeping whatever detail distinguishes it from a',
    'similar template. At most 6 words.',
  ].join('\n')
}

/** One turn, no tools, no MCP: naming a piece of text needs neither, and both
 *  cost seconds of cold start. Variadic `--tools` stays last. */
export function promptNameArguments(): readonly string[] {
  return [
    '-p', '--output-format', 'text',
    '--model', 'haiku',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '',
  ]
}

/**
 * The usable name in a model reply, or undefined when there is none.
 *
 * A one-line answer is what the prompt asks for and usually what comes back,
 * but "usually" is not a contract: the reply is scrubbed to what a file name
 * may hold and then held to the same {@link PROMPT_NAME} guard the write path
 * uses, so a chatty or malformed answer is dropped rather than offered.
 */
export function suggestedName(output: string): string | undefined {
  const line = output.split('\n').map(text => text.trim()).find(text => text.length > 0) ?? ''
  const bare = line.replace(/^["'`]+|["'`]+$/gu, '').replace(/\.md$/iu, '')
  const scrubbed = wordBounded(bare
    .replace(/[^\p{L}\p{M}\p{N} ._()\[\]-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim())
  return PROMPT_NAME.test(scrubbed) ? scrubbed : undefined
}

/** Cut a long name at its last word boundary. A name the user has to repair
 *  ("analyze-frontend-backend-create-jira-tic") is worse than a shorter one. */
function wordBounded(name: string): string {
  if (name.length <= MAX_SUGGESTED_NAME_CHARS) return name
  const cut = name.slice(0, MAX_SUGGESTED_NAME_CHARS)
  const boundary = cut.search(/[\s\-_][^\s\-_]*$/u)
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trim()
}

/** Names a draft with Claude Code's cheapest model. */
export class PromptNamingService {
  readonly #runtime: Pick<SubprocessRuntime, 'spawn'>
  readonly #executablePath: () => string

  constructor(runtime: Pick<SubprocessRuntime, 'spawn'>, executablePath: () => string) {
    this.#runtime = runtime
    this.#executablePath = executablePath
  }

  /** The suggested name, or undefined whenever one cannot be had. The caller
   *  already has a name derived locally, so every failure here is a
   *  non-event: nothing is reported, and nothing is retried. */
  async suggest(draft: string, signal?: AbortSignal): Promise<string | undefined> {
    const executablePath = this.#executablePath()
    if (executablePath.length === 0 || draft.trim().length === 0) return undefined
    const timeout = AbortSignal.timeout(NAME_TIMEOUT_MS)
    try {
      const handle = this.#runtime.spawn({
        argv: [executablePath, ...promptNameArguments()],
        // Nowhere in particular: no tool can reach the file system, and a
        // project directory would only pull that project's CLAUDE.md in.
        cwd: homedir(),
        stdio: {
          stdin: { data: promptNamePrompt(draft) },
          stdout: { maxBytes: MAX_NAME_OUTPUT_BYTES },
          stderr: { maxBytes: MAX_NAME_OUTPUT_BYTES },
        },
        graceMs: 1_000,
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        // Extended thinking was 340 of this call's 358 output tokens and most
        // of its ten seconds, spent deliberating over a file name. Turning it
        // off takes the call from ~10s to ~3s. A CLI that stops honouring the
        // variable is slow again, never wrong.
        env: { MAX_THINKING_TOKENS: '0' },
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) return undefined
      return suggestedName(handle.collected.stdout?.readFrom(0).text ?? '')
    } catch {
      return undefined
    }
  }
}

/** List the user's prompt snippets, and save the composer draft as a new one. */
export function registerClaudePromptsRoute(ctx: Context, directory: string = claudePromptsDir()): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_PROMPTS_PATH,
    methods: ['GET', 'POST'],
    budget: 'fast',
    handler: async (io) => {
      if (io.method === 'GET') return { status: 200, value: { prompts: await readClaudePrompts(directory) } }
      const payload = await io.body<{ name?: unknown; body?: unknown }>(MAX_REQUEST_BYTES)
      try {
        const prompt = await writeClaudePrompt(directory, payload.name, payload.body)
        return { status: 200, value: { saved: true, prompt } }
      } catch (error) {
        if (error instanceof ClaudePromptWriteError) {
          return { status: error.code === 'name-taken' ? 409 : 400, value: { error: error.code, message: error.message } }
        }
        return { status: 500, value: { error: 'prompt-write-failed', message: 'The prompt could not be saved.' } }
      }
    },
  })
}

/** Suggest a file name for a draft. Answers `{}` when no name could be had:
 *  the caller keeps the name it derived locally, so this is never an error. */
export function registerClaudePromptNameRoute(ctx: Context, service: Pick<PromptNamingService, 'suggest'>): void {
  registerPluginRoute(ctx, {
    mode: 'unary',
    kind: 'exact',
    path: CLAUDE_PROMPT_NAME_PATH,
    methods: ['POST'],
    // Not Git, but the same order of magnitude: one cold Claude Code start.
    budget: 'git',
    handler: async (io) => {
      const payload = await io.body<{ draft?: unknown }>(MAX_REQUEST_BYTES)
      const draft = typeof payload.draft === 'string' ? payload.draft : ''
      const name = await service.suggest(draft, io.signal)
      return { status: 200, value: name === undefined ? {} : { name } }
    },
  })
}
