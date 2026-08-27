import { StringDecoder } from 'node:string_decoder'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const MAX_SELECTION_CHARS = 8_000
const MAX_CONTEXT_CHARS = 16_000
const MAX_QUESTION_CHARS = 2_000
const ASK_TIMEOUT_MS = 180_000
const MAX_STDERR_BYTES = 64 * 1024

type AskRuntime = Pick<SubprocessRuntime, 'spawn'>

export interface AskRequest {
  readonly selection: string
  readonly context?: string
  readonly question: string
}

/** Model and effort the session last ran with; mirrored onto the side query. */
export interface AskPreferences {
  readonly model?: string
  readonly thinkingMode?: string
}

export class AskError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AskError'
    this.code = code
  }
}

function fence(value: string): string {
  return `"""\n${value.replaceAll('"""', '" " "')}\n"""`
}

export function askPrompt(request: AskRequest): string {
  const selection = request.selection.trim().slice(0, MAX_SELECTION_CHARS)
  const context = (request.context ?? '').trim().slice(0, MAX_CONTEXT_CHARS)
  const question = request.question.trim().slice(0, MAX_QUESTION_CHARS)
  return [
    'You are answering a follow-up question about part of an earlier assistant reply in this project.',
    '',
    'Selected passage:',
    fence(selection),
    ...(context.length === 0 || context === selection ? [] : ['', 'Surrounding reply, for context only:', fence(context)]),
    '',
    `Question: ${question}`,
    '',
    'Answer the question directly and concisely, in the same language as the question. Use Markdown.',
  ].join('\n')
}

/** CLI effort for a session thinking mode; `off` and unknown modes send nothing. */
export function effortFor(thinkingMode: string | undefined): string | undefined {
  if (thinkingMode === undefined || thinkingMode === 'off') return undefined
  if (thinkingMode === 'ultracode') return 'max'
  return ['low', 'medium', 'high', 'max'].includes(thinkingMode) ? thinkingMode : undefined
}

export function askArguments(preferences: AskPreferences): readonly string[] {
  const effort = effortFor(preferences.thinkingMode)
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '',
    ...(preferences.model === undefined || preferences.model === 'default' ? [] : ['--model', preferences.model]),
    ...(effort === undefined ? [] : ['--effort', effort]),
  ]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Text carried by one stream-json line: a partial delta or the final result. */
export function textOfStreamLine(line: string): { readonly delta?: string; readonly result?: string } | undefined {
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = record(JSON.parse(line))
  } catch {
    return undefined
  }
  if (parsed === undefined) return undefined
  if (parsed.type === 'stream_event') {
    const event = record(parsed.event)
    const delta = record(event?.delta)
    if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') return { delta: delta.text }
    return undefined
  }
  if (parsed.type === 'result' && typeof parsed.result === 'string') return { result: parsed.result }
  return undefined
}

/** One-shot Claude Code query answering a question about selected reply text. */
export class AskService {
  readonly #runtime: AskRuntime
  readonly #executablePath: string

  constructor(runtime: AskRuntime, executablePath: string) {
    this.#runtime = runtime
    this.#executablePath = executablePath
  }

  async ask(cwd: string, request: AskRequest, preferences: AskPreferences, onDelta: (text: string) => void, signal?: AbortSignal): Promise<void> {
    if (request.question.trim().length === 0 || request.selection.trim().length === 0) {
      throw new AskError('invalid-request', 'A selection and a question are required.')
    }
    if (this.#executablePath.length === 0) throw new AskError('claude-unavailable', 'Claude Code is unavailable.')
    const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS)
    const handle = this.#runtime.spawn({
      argv: [this.#executablePath, ...askArguments(preferences), askPrompt(request)],
      cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: MAX_STDERR_BYTES } },
      graceMs: 1_000,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      env: {},
    })
    const stdout = handle.stdout
    if (stdout === undefined) throw new AskError('ask-failed', 'Claude output is unavailable.')
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let emitted = false
    let result: string | undefined
    const consume = (line: string): void => {
      const text = textOfStreamLine(line)
      if (text?.delta !== undefined && text.delta.length > 0) {
        emitted = true
        onDelta(text.delta)
      }
      if (text?.result !== undefined) result = text.result
    }
    for await (const chunk of stdout) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim().length > 0) consume(line)
    }
    buffer += decoder.end()
    if (buffer.trim().length > 0) consume(buffer)
    const outcome = await handle.done
    if (!emitted && result !== undefined && result.length > 0) {
      emitted = true
      onDelta(result)
    }
    if (!emitted) {
      if (signal?.aborted === true) throw new AskError('aborted', 'The question was cancelled.')
      if (timeout.aborted) throw new AskError('timeout', 'Claude took too long to answer.')
      const stderr = handle.collected.stderr?.readFrom(0).text.trim().split(/\r?\n/u).filter(line => line.length > 0).at(-1)
      throw new AskError('ask-failed', stderr !== undefined && stderr.length > 0 ? stderr : `Claude exited with code ${String(outcome.exitCode)}.`)
    }
  }
}
