import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClaudeTranscriptToolItem } from '../src/client/ClaudeActivityNode.tsx'
import type { ClaudeTranscriptTool } from '../src/client/conversation-sidecar.ts'
import { en } from '../src/client/locales.ts'

const t = ((key: keyof typeof en, params?: Record<string, unknown>) => {
  const copy = en[key]
  return params === undefined ? copy : copy.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name]))
}) as never

function card(tool: Partial<ClaudeTranscriptTool>): string {
  return renderToStaticMarkup(<ClaudeTranscriptToolItem t={t} tool={{
    toolUseId: 'call-1',
    toolName: 'Bash',
    description: 'Ran a command',
    subcalls: [],
    ...tool,
  }} />)
}

describe('ClaudeTranscriptToolItem', () => {
  it('writes a command the way it was typed, at a prompt', () => {
    const markup = card({
      input: JSON.stringify({ command: 'pnpm run check', description: 'Run full check' }),
      output: JSON.stringify({ stdout: 'Test Files  76 passed' }),
    })

    expect(markup).toContain('dsh-claude-tool-terminal')
    expect(markup).toContain('pnpm run check')
    expect(markup).toContain('Test Files  76 passed')
    // The command belongs to the prompt line, not to the field table under it,
    // and the description is already the card's own title.
    expect(markup).not.toContain('>command<')
    expect(markup).not.toContain('>description<')
  })

  it('still draws the tools that are not a shell', () => {
    const markup = card({
      toolName: 'Read',
      description: 'Read /tmp/x',
      input: JSON.stringify({ file_path: '/tmp/x' }),
      output: JSON.stringify({ file: { filePath: '/tmp/x', content: 'hello' } }),
    })

    expect(markup).toContain('/tmp/x')
    expect(markup).toContain('hello')
    expect(markup).not.toContain('dsh-claude-tool-terminal')
  })
})
