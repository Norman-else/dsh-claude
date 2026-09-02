/**
 * Presentation-only tool definitions for the Claude Code preset. Claude Code
 * owns tool execution; these definitions exist solely so the host's tool
 * presentation pipeline (`viewFor` → `presentCall`/`presentResult`) can
 * compute native render intents for the mirrored `tool/call`/`tool/result`
 * events, giving Claude tool rows the same cards DSH-executed tools get.
 */
import type { ToolDefinition, ToolResult } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function resultText(result: ToolResult): string {
  return result.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Bash: a terminal card headed by the command, described above by Claude's own summary. */
export function bashCallView(args: unknown): ToolCallView | undefined {
  const command = str(record(args)?.command)
  if (command === undefined) return undefined
  const description = str(record(args)?.description)
  return { card: 'terminal', title: command, ...(description === undefined ? {} : { description }) }
}

export function terminalResultView(_args: unknown, result: ToolResult): ToolResultView | undefined {
  const output = resultText(result)
  return output.length === 0 ? undefined : { card: 'terminal', output }
}

/** Read: a generic read card that follow-alongs the file window. */
export function readCallView(args: unknown): ToolCallView | undefined {
  const arguments_ = record(args)
  const path = str(arguments_?.file_path)
  if (path === undefined) return undefined
  const offset = typeof arguments_?.offset === 'number' ? arguments_.offset : undefined
  return {
    card: 'generic',
    kind: 'read',
    title: `Read ${path}`,
    locations: [{ path, ...(offset === undefined ? {} : { line: offset }) }],
  }
}

function fileDiffs(args: unknown): { path: string; oldText: string | null; newText: string }[] | undefined {
  const arguments_ = record(args)
  const path = str(arguments_?.file_path)
  if (path === undefined) return undefined
  if (Array.isArray(arguments_?.edits)) {
    const diffs: { path: string; oldText: string | null; newText: string }[] = []
    for (const edit of arguments_.edits) {
      const item = record(edit)
      const oldText = str(item?.old_string)
      const newText = str(item?.new_string)
      if (newText === undefined) continue
      diffs.push({ path, oldText: oldText ?? null, newText })
    }
    return diffs.length > 0 ? diffs : undefined
  }
  const newText = str(arguments_?.new_string) ?? arguments_?.content
  if (typeof newText !== 'string' || newText.length === 0) return undefined
  const oldText = str(arguments_?.old_string)
  return [{ path, oldText: oldText ?? null, newText }]
}

/** Edit / MultiEdit / Write: inline diff cards derived from the call arguments. */
export function diffCallView(args: unknown): ToolCallView | undefined {
  const arguments_ = record(args)
  const path = str(arguments_?.file_path)
  const diffs = fileDiffs(args)
  if (path === undefined || diffs === undefined) return undefined
  const verb = typeof arguments_?.new_string === 'string' || Array.isArray(arguments_?.edits) ? 'Edit' : 'Write'
  return { card: 'diff', title: `${verb} ${path}`, diffs, locations: [{ path }] }
}

/** Edit / MultiEdit / Write results: the same diff, again.
 *
 *  A completed card replaces the pending one, so a mutation that returns no
 *  result view loses its diff to the raw result text. The plugin transcript
 *  drops the diff on failure and shows the error instead; mirror that. */
export function diffResultView(args: unknown, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  const diffs = fileDiffs(args)
  return diffs === undefined ? undefined : { card: 'diff', diffs }
}

function parsedResult(result: ToolResult): unknown {
  const text = resultText(result)
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** Grep / Glob results: the discovered paths as a search card.
 *
 *  Only the structured `filenames` shape is projected. A text result (Grep's
 *  content mode) carries its own formatting, so it falls through to the raw
 *  result content rather than being re-parsed into fake match groups. */
export function searchResultView(_args: unknown, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  const output = record(parsedResult(result))
  if (!Array.isArray(output?.filenames)) return undefined
  const paths = output.filenames.filter((item): item is string => typeof item === 'string')
  const reported = output.numFiles
  const total = typeof reported === 'number' && Number.isInteger(reported) && reported >= paths.length ? reported : paths.length
  return { card: 'search', shape: 'paths', paths, truncated: total > paths.length, total }
}

/** Grep / Glob / WebSearch: search-category cards titled by the query. */
export function searchCallView(args: unknown): ToolCallView | undefined {
  const arguments_ = record(args)
  const query = str(arguments_?.pattern) ?? str(arguments_?.query)
  if (query === undefined) return undefined
  const scope = str(arguments_?.path)
  return {
    card: 'generic',
    kind: 'search',
    title: scope === undefined ? query : `${query} · ${scope}`,
    rawInput: args,
  }
}

/** WebFetch: a fetch-category card titled by the URL. */
export function fetchCallView(args: unknown): ToolCallView | undefined {
  const url = str(record(args)?.url)
  if (url === undefined) return undefined
  return { card: 'generic', kind: 'fetch', title: url, rawInput: args }
}

/** ExitPlanMode: the plan itself, as prose rather than as tool arguments.
 *
 *  This is the one built-in tool whose whole payload is written for the user
 *  to read: Claude asks to leave plan mode and the approval that follows is
 *  the user agreeing to the plan. Rendering it as `Input: {"plan":"..."}`
 *  buries the only thing worth reading, so the plan becomes the card body. */
export function planCallView(args: unknown): ToolCallView | undefined {
  const plan = str(record(args)?.plan)
  return plan === undefined ? undefined : {
    card: 'generic',
    kind: 'other',
    title: 'Plan ready for review',
    content: [{ type: 'text', text: plan }],
  }
}

/** Task: a subagent card titled by Claude's task description. */
export function taskCallView(args: unknown): ToolCallView | undefined {
  const arguments_ = record(args)
  const title = str(arguments_?.description) ?? str(arguments_?.subagent_type) ?? 'Subagent'
  return { card: 'generic', kind: 'other', title, rawInput: args }
}

function genericTitle(title: string): ToolCallView {
  return { card: 'generic', kind: 'other', title }
}

function presenterDefinition(
  name: string,
  description: string,
  presentCall?: (args: unknown) => ToolCallView | undefined,
  presentResult?: (args: unknown, result: ToolResult) => ToolResultView | undefined,
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} } as ToolDefinition['output']['schema'],
      render: () => [],
    },
    execute: async () => {
      throw new Error(`dsh-claude: Claude Code owns execution of ${name}`)
    },
    ...(presentCall === undefined ? {} : { presentCall }),
    ...(presentResult === undefined ? {} : { presentResult }),
  }
}

const PRESENTATION_NOTE = 'Presentation mirror of the Claude Code tool; execution is owned by Claude Code.'

/** Generic call view for dynamically observed tools (MCP tools, new built-ins). */
export function genericCallView(toolName: string): (args: unknown) => ToolCallView | undefined {
  return (args: unknown) => {
    const description = str(record(args)?.description)
    return { card: 'generic', kind: 'other', title: description ?? toolName, rawInput: args }
  }
}

/** One presenter-only mirror for a tool name discovered at runtime. */
export function dynamicPresenterDefinition(name: string): ToolDefinition {
  return presenterDefinition(name, PRESENTATION_NOTE, genericCallView(name))
}

/** The presentation-only registry contributed to the Claude Code preset scope. */
export function claudePresenterDefinitions(): ToolDefinition[] {
  return [
    presenterDefinition('Bash', PRESENTATION_NOTE, bashCallView, terminalResultView),
    // The plugin transcript gives PowerShell the same terminal treatment as
    // Bash; without its own mirror the native card would fall back to generic.
    presenterDefinition('PowerShell', PRESENTATION_NOTE, bashCallView, terminalResultView),
    presenterDefinition('Read', PRESENTATION_NOTE, readCallView),
    presenterDefinition('Edit', PRESENTATION_NOTE, diffCallView, diffResultView),
    presenterDefinition('MultiEdit', PRESENTATION_NOTE, diffCallView, diffResultView),
    presenterDefinition('Write', PRESENTATION_NOTE, diffCallView, diffResultView),
    presenterDefinition('NotebookEdit', PRESENTATION_NOTE, args => {
      const path = str(record(args)?.notebook_path)
      return path === undefined ? undefined : genericTitle(`NotebookEdit ${path}`)
    }),
    presenterDefinition('Grep', PRESENTATION_NOTE, searchCallView, searchResultView),
    presenterDefinition('Glob', PRESENTATION_NOTE, searchCallView, searchResultView),
    presenterDefinition('WebSearch', PRESENTATION_NOTE, searchCallView),
    presenterDefinition('WebFetch', PRESENTATION_NOTE, fetchCallView),
    presenterDefinition('Task', PRESENTATION_NOTE, taskCallView),
    presenterDefinition('ExitPlanMode', PRESENTATION_NOTE, planCallView),
    presenterDefinition('TodoWrite', PRESENTATION_NOTE, () => genericTitle('Update todos')),
  ]
}

/** Names covered by the static preset-scope registry; dynamic mirrors skip them. */
export const CLAUDE_PRESENTER_NAMES: ReadonlySet<string> = new Set(claudePresenterDefinitions().map(definition => definition.name))
