import { describe, expect, it } from 'vitest'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import {
  bashCallView,
  claudePresenterDefinitions,
  CLAUDE_PRESENTER_NAMES,
  diffCallView,
  dynamicPresenterDefinition,
  fetchCallView,
  genericCallView,
  readCallView,
  searchCallView,
  taskCallView,
  terminalResultView,
} from '../src/presenters.ts'

const toolResult = (text: string, isError = false): ToolResult => ({
  content: text.length === 0 ? [] : [{ type: 'text', text }],
  isError,
})

describe('Claude presenter views', () => {
  it('renders Bash as a terminal card headed by the command', () => {
    expect(bashCallView({ command: 'ls -la', description: 'List files' })).toEqual({
      card: 'terminal',
      title: 'ls -la',
      description: 'List files',
    })
    expect(bashCallView({ description: 'no command' })).toBeUndefined()
  })

  it('renders Bash results as terminal output', () => {
    expect(terminalResultView({}, toolResult('listed'))).toEqual({ card: 'terminal', output: 'listed' })
    expect(terminalResultView({}, toolResult(''))).toBeUndefined()
  })

  it('renders Read with a follow-along file location', () => {
    expect(readCallView({ file_path: 'src/index.ts', offset: 12 })).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Read src/index.ts',
      locations: [{ path: 'src/index.ts', line: 12 }],
    })
    expect(readCallView({})).toBeUndefined()
  })

  it('renders Edit as a diff card and Write as a create diff', () => {
    expect(diffCallView({ file_path: 'a.ts', old_string: 'before', new_string: 'after' })).toMatchObject({
      card: 'diff',
      title: 'Edit a.ts',
      diffs: [{ path: 'a.ts', oldText: 'before', newText: 'after' }],
    })
    expect(diffCallView({ file_path: 'b.ts', content: 'fresh' })).toMatchObject({
      card: 'diff',
      title: 'Write b.ts',
      diffs: [{ path: 'b.ts', oldText: null, newText: 'fresh' }],
    })
    expect(diffCallView({
      file_path: 'c.ts',
      edits: [{ old_string: 'x', new_string: 'y' }, { new_string: 'z' }],
    })).toMatchObject({
      diffs: [
        { path: 'c.ts', oldText: 'x', newText: 'y' },
        { path: 'c.ts', oldText: null, newText: 'z' },
      ],
    })
  })

  it('renders searches and fetches with their salient query', () => {
    expect(searchCallView({ pattern: 'TODO', path: 'src' })).toMatchObject({
      card: 'generic',
      kind: 'search',
      title: 'TODO · src',
    })
    expect(searchCallView({ query: 'dsh' })).toMatchObject({ title: 'dsh' })
    expect(fetchCallView({ url: 'https://example.com' })).toMatchObject({ card: 'generic', kind: 'fetch', title: 'https://example.com' })
    expect(taskCallView({ description: 'Survey the repo' })).toMatchObject({ title: 'Survey the repo' })
  })

  it('registers presenter-only mirrors that refuse execution', async () => {
    const definitions = claudePresenterDefinitions()
    expect(definitions.map(definition => definition.name)).toContain('Bash')
    expect(definitions.length).toBe(12)
    expect(CLAUDE_PRESENTER_NAMES.has('Bash')).toBe(true)
    expect(CLAUDE_PRESENTER_NAMES.size).toBe(12)
    for (const definition of definitions) {
      expect(definition.output.render({}, null)).toEqual([])
      await expect(definition.execute({}, {} as never)).rejects.toThrow(/Claude Code owns execution/)
    }
  })

  it('builds dynamic mirrors for runtime-discovered tool names', async () => {
    const definition = dynamicPresenterDefinition('mcp__obsidian__search_simple')
    expect(definition.name).toBe('mcp__obsidian__search_simple')
    expect(CLAUDE_PRESENTER_NAMES.has(definition.name)).toBe(false)
    expect(definition.presentCall?.({ description: 'Search the vault' })).toMatchObject({
      card: 'generic',
      kind: 'other',
      title: 'Search the vault',
    })
    expect(definition.presentCall?.({ query: 'Navi' })).toMatchObject({ title: 'mcp__obsidian__search_simple' })
    await expect(definition.execute({}, {} as never)).rejects.toThrow(/Claude Code owns execution/)
    expect(genericCallView('ToolSearch')({})).toMatchObject({ title: 'ToolSearch' })
  })
})
