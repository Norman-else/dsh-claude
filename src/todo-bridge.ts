/**
 * Claude's task list, fed to the Host's own to-do dock.
 *
 * The Host draws the dock above the composer from the `todos` session
 * projection, which `dsh-tool-todo` folds from `todo/write` events -- whole-list
 * snapshots of `{ content, status }`. The projection table is process-wide, so
 * a Claude session only has to put those events in its log. Claude keeps its
 * list either with `TodoWrite` (the whole list each call) or with the task
 * tools (`TaskCreate` returns an id, `TaskUpdate` patches one); both are
 * folded here into the same snapshot shape. No Node imports: the client's
 * team roster reads `createdTaskId` from here too.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  readonly content: string
  readonly status: TodoStatus
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function todoStatus(value: unknown): TodoStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined
}

/** The id a TaskCreate result names: a structured `id`, else `#N` in its prose. */
export function createdTaskId(output: unknown): string | undefined {
  const structured = record(output)
  const id = structured?.id ?? record(structured?.task)?.id
  if (typeof id === 'string' || typeof id === 'number') return String(id)
  const prose = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  const match = /#(\d+)/u.exec(prose) ?? /\btask\s+(?:id\s*)?[:#]?\s*(\d+)\b/iu.exec(prose)
  return match?.[1]
}

/** One distinct row per content, as the Host's dock keys its rows by content. */
function distinct(items: readonly TodoItem[]): readonly TodoItem[] {
  const seen = new Set<string>()
  return items.filter(item => !seen.has(item.content) && seen.add(item.content))
}

/** A `TodoWrite` call's whole list, or undefined for input that is not one. */
export function todosFromTodoWrite(input: unknown): readonly TodoItem[] | undefined {
  const todos = record(input)?.todos
  if (!Array.isArray(todos)) return undefined
  return distinct(todos.flatMap(item => {
    const entry = record(item)
    const content = text(entry?.content)
    const status = todoStatus(entry?.status)
    return content === undefined || status === undefined ? [] : [{ content, status }]
  }))
}

/** The latest list a session log holds, while any of it is still open: what a
 *  new turn carries over, since the Host's projection empties at `turn/start`. */
export function carriedTodos(events: readonly { type: string; data: unknown }[]): readonly TodoItem[] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'todo/write') continue
    const todos = todosFromTodoWrite(event.data)
    return todos !== undefined && todos.some(item => item.status !== 'completed') ? todos : undefined
  }
  return undefined
}

/**
 * The task tools' board, one per Claude process.
 * ponytail: lives with the process, so a restarted CLI starts an empty board;
 * a TaskUpdate for an id it never saw created still lands, under `#id`.
 */
export class ClaudeTaskBoard {
  readonly #tasks = new Map<string, { subject: string; status: TodoStatus }>()
  readonly #creating = new Map<string, string>()

  /** Fold one tool call; true when the board changed. */
  call(toolName: string, toolUseId: string, input: unknown): boolean {
    const args = record(input)
    if (toolName === 'TaskCreate') {
      const subject = text(args?.subject)
      if (subject !== undefined) this.#creating.set(toolUseId, subject)
      return false
    }
    if (toolName !== 'TaskUpdate') return false
    const raw = args?.taskId
    const id = typeof raw === 'number' ? String(raw) : text(raw)
    if (id === undefined) return false
    if (args?.status === 'deleted') return this.#tasks.delete(id)
    const previous = this.#tasks.get(id)
    const subject = text(args?.subject) ?? previous?.subject ?? `#${id}`
    const status = todoStatus(args?.status) ?? previous?.status ?? 'pending'
    if (previous?.subject === subject && previous.status === status) return false
    this.#tasks.set(id, { subject, status })
    return true
  }

  /** Fold one tool result; true when a created task joined the board. */
  result(toolUseId: string, outputs: readonly unknown[], isError: boolean): boolean {
    const subject = this.#creating.get(toolUseId)
    if (subject === undefined) return false
    this.#creating.delete(toolUseId)
    if (isError) return false
    const id = outputs.reduce<string | undefined>((found, output) => found ?? createdTaskId(output), undefined)
    this.#tasks.set(id ?? toolUseId, { subject, status: 'pending' })
    return true
  }

  todos(): readonly TodoItem[] {
    return distinct([...this.#tasks.values()].map(task => ({ content: task.subject, status: task.status })))
  }
}
