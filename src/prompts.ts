import { homedir } from 'node:os'
import { mkdir, opendir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLAUDE_PROMPTS_PATH } from './constants.ts'
import { redactText } from './events.ts'
import { registerPluginRoute } from './http.ts'

/** One prompt file as the composer menu sees it: the file name is the menu
 *  row, the body is what lands in the composer verbatim. */
export interface ClaudePromptView {
  name: string
  description: string
  body: string
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
      const body = await readFile(join(directory, entry.name), 'utf8')
      if (body.trim().length === 0 || Buffer.byteLength(body) > MAX_PROMPT_BYTES) continue
      prompts.push({ name, description: summarize(body), body })
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
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(join(directory, `${name}.md`), text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ClaudePromptWriteError('name-taken', 'A prompt with that name already exists.')
    }
    throw error
  }
  return { name, description: summarize(text), body: text }
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
