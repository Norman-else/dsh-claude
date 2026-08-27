import { StringDecoder } from 'node:string_decoder'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const MAX_SELECTION_CHARS = 8_000
const MAX_CONTEXT_CHARS = 16_000
const MAX_QUESTION_CHARS = 2_000
const ASK_TIMEOUT_MS = 180_000
const MAX_STDERR_BYTES = 64 * 1024
const MAX_TOOL_SUMMARY_CHARS = 160
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const

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
    'Only the read-only tools Read, Grep, and Glob are available; use them when the answer depends on project code, otherwise answer from the passage.',
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
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // No MCP servers: a follow-up question never needs them and connecting
    // them roughly doubles cold start.
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ...(preferences.model === undefined || preferences.model === 'default' ? [] : ['--model', preferences.model]),
    ...(effort === undefined ? [] : ['--effort', effort]),
    // Read-only inspection only; both flags are variadic, so they stay last
    // and the prompt travels over stdin.
    '--tools', ...READ_ONLY_TOOLS, '--allowedTools', ...READ_ONLY_TOOLS,
  ]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** What one stream-json line contributes: streamed answer text, streamed
 *  thinking, or the final result (used only when no text streamed). */
export type AskToolPhase = 'start' | 'input' | 'done'

export type AskStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'status'; readonly text: string }
  | { readonly type: 'tool'; readonly id: string; readonly phase: AskToolPhase; readonly name?: string; readonly summary?: string; readonly error?: boolean }
  | { readonly type: 'result'; readonly text: string }

/** One-line description of a tool call, mirroring the main window's step titles. */
export function toolSummary(input: unknown): string | undefined {
  const fields = record(input)
  if (fields === undefined) return undefined
  const candidate = [fields.command, fields.pattern, fields.file_path, fields.path, fields.query].find(value => typeof value === 'string' && value.length > 0)
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(fields)
  return text.replaceAll(/\s+/gu, ' ').trim().slice(0, MAX_TOOL_SUMMARY_CHARS)
}

export function eventsOfStreamLine(line: string): readonly AskStreamEvent[] {
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = record(JSON.parse(line))
  } catch {
    return []
  }
  if (parsed === undefined) return []
  if (parsed.type === 'system' && parsed.subtype === 'init') return [{ type: 'status', text: 'ready' }]
  if (parsed.type === 'stream_event') {
    const event = record(parsed.event)
    if (event?.type === 'content_block_start') {
      const block = record(event.content_block)
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        return [{ type: 'tool', id: block.id, phase: 'start', name: block.name }]
      }
      return []
    }
    const delta = record(event?.delta)
    if (event?.type !== 'content_block_delta' || delta === undefined) return []
    if (delta.type === 'text_delta' && typeof delta.text === 'string') return [{ type: 'text', text: delta.text }]
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') return [{ type: 'thinking', text: delta.thinking }]
    return []
  }
  if (parsed.type === 'assistant' || parsed.type === 'user') {
    const content = record(parsed.message)?.content
    if (!Array.isArray(content)) return []
    const events: AskStreamEvent[] = []
    for (const item of content) {
      const block = record(item)
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const summary = toolSummary(block.input)
        events.push({ type: 'tool', id: block.id, phase: 'input', name: block.name, ...(summary === undefined ? {} : { summary }) })
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        events.push({ type: 'tool', id: block.tool_use_id, phase: 'done', ...(block.is_error === true ? { error: true } : {}) })
      }
    }
    return events
  }
  if (parsed.type === 'result' && typeof parsed.result === 'string') return [{ type: 'result', text: parsed.result }]
  return []
}

export type AskProgressEvent = Exclude<AskStreamEvent, { type: 'result' }>

/** One-shot Claude Code query answering a question about selected reply text. */
export class AskService {
  readonly #runtime: AskRuntime
  readonly #executablePath: string

  constructor(runtime: AskRuntime, executablePath: string) {
    this.#runtime = runtime
    this.#executablePath = executablePath
  }

  async ask(cwd: string, request: AskRequest, preferences: AskPreferences, onEvent: (event: AskProgressEvent) => void, signal?: AbortSignal): Promise<void> {
    if (request.question.trim().length === 0 || request.selection.trim().length === 0) {
      throw new AskError('invalid-request', 'A selection and a question are required.')
    }
    if (this.#executablePath.length === 0) throw new AskError('claude-unavailable', 'Claude Code is unavailable.')
    const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS)
    // The prompt rides stdin: `--tools ''` is variadic and would swallow a
    // trailing positional prompt argument.
    const handle = this.#runtime.spawn({
      argv: [this.#executablePath, ...askArguments(preferences)],
      cwd,
      stdio: { stdin: { data: askPrompt(request) }, stdout: 'pipe', stderr: { maxBytes: MAX_STDERR_BYTES } },
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
      for (const event of eventsOfStreamLine(line)) {
        if (event.type === 'result') {
          result = event.text
          continue
        }
        if (event.type !== 'tool' && event.text.length === 0) continue
        if (event.type === 'text') emitted = true
        onEvent(event)
      }
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
      onEvent({ type: 'text', text: result })
    }
    if (!emitted) {
      if (signal?.aborted === true) throw new AskError('aborted', 'The question was cancelled.')
      if (timeout.aborted) throw new AskError('timeout', 'Claude took too long to answer.')
      const stderr = handle.collected.stderr?.readFrom(0).text.trim().split(/\r?\n/u).filter(line => line.length > 0).at(-1)
      throw new AskError('ask-failed', stderr !== undefined && stderr.length > 0 ? stderr : `Claude exited with code ${String(outcome.exitCode)}.`)
    }
  }
}
