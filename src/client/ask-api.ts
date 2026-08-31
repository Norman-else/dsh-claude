import { CLAUDE_ASK_PATH } from '../constants.ts'
import { PluginRequestError, pluginNdjson } from './plugin-transport.ts'

export interface AskSelectionRequest {
  readonly selection: string
  readonly context?: string
  readonly question: string
}

export interface AskToolEvent {
  readonly type: 'tool'
  readonly id: string
  readonly phase: 'start' | 'input' | 'done'
  readonly name?: string
  readonly summary?: string
  readonly error?: boolean
}

export type AskEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'status'; readonly text: string }
  | AskToolEvent
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string }

export type AskProgress = { readonly type: 'text' | 'thinking' | 'status'; readonly text: string } | AskToolEvent

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function parseAskEvent(line: string): AskEvent {
  const event = record(JSON.parse(line) as unknown)
  if (event?.type === 'delta' && typeof event.text === 'string') return { type: 'delta', text: event.text }
  if (event?.type === 'thinking' && typeof event.text === 'string') return { type: 'thinking', text: event.text }
  if (event?.type === 'status' && typeof event.text === 'string') return { type: 'status', text: event.text }
  if (event?.type === 'tool' && typeof event.id === 'string' && (event.phase === 'start' || event.phase === 'input' || event.phase === 'done')) {
    return {
      type: 'tool',
      id: event.id,
      phase: event.phase,
      ...(typeof event.name === 'string' ? { name: event.name } : {}),
      ...(typeof event.summary === 'string' ? { summary: event.summary } : {}),
      ...(event.error === true ? { error: true } : {}),
    }
  }
  if (event?.type === 'done') return { type: 'done' }
  if (event?.type === 'error') return { type: 'error', message: typeof event.message === 'string' ? event.message : 'The question could not be answered.' }
  throw new Error('Invalid ask stream event.')
}

async function openAnswer(sessionId: string, request: AskSelectionRequest, cancel: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  try {
    return await pluginNdjson(CLAUDE_ASK_PATH, cancel, { method: 'POST', query: { sessionId }, json: request })
  } catch (error) {
    // A refused stream is reported by status rather than by body, and the panel
    // shows whatever sentence arrives here.
    if (error instanceof PluginRequestError && error.reason === 'http') throw new Error('The question could not be sent.')
    throw error
  }
}

/** Stream an answer about selected reply text; resolves when the answer completes. */
export async function askAboutSelection(
  sessionId: string,
  request: AskSelectionRequest,
  onProgress: (progress: AskProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  // The transport holds this stream's permit until its cancellation fires, so
  // the answer carries a signal of its own: an answer that ran to completion
  // has to give the connection back as surely as an abandoned one.
  const carrier = new AbortController()
  const stop = (): void => { carrier.abort() }
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted === true) carrier.abort()
  try {
    const reader = await openAnswer(sessionId, request, carrier.signal)
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false
    const handle = (line: string): void => {
      if (line.trim().length === 0) return
      const event = parseAskEvent(line)
      if (event.type === 'delta') onProgress({ type: 'text', text: event.text })
      else if (event.type === 'thinking') onProgress({ type: 'thinking', text: event.text })
      else if (event.type === 'status') onProgress({ type: 'status', text: event.text })
      else if (event.type === 'tool') onProgress(event)
      else if (event.type === 'done') finished = true
      else throw new Error(event.message)
    }
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handle(line)
      if (chunk.done) break
    }
    handle(buffer)
    if (!finished) throw new Error('The answer ended unexpectedly.')
  } finally {
    signal?.removeEventListener('abort', stop)
    carrier.abort()
  }
}
