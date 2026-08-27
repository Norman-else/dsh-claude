import { CLAUDE_ASK_PATH } from '../constants.ts'

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

/** Stream an answer about selected reply text; resolves when the answer completes. */
export async function askAboutSelection(
  sessionId: string,
  request: AskSelectionRequest,
  onProgress: (progress: AskProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${CLAUDE_ASK_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    const body = record(await response.json().catch(() => undefined))
    throw new Error(typeof body?.message === 'string' ? body.message : 'The question could not be sent.')
  }
  if (response.body === null) throw new Error('The answer stream is unavailable.')
  const reader = response.body.getReader()
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
}
