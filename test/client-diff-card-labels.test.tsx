/** The diff card's chrome contract with the Host's primitive.
 *
 *  Primitives 0.1.2 moved the card's copy/fold/footer strings onto the caller
 *  and reads them while it builds, so a Host on that build blew up mid-render
 *  on the plugin's label-less `<DiffBlock>` — and React answered by unmounting
 *  the whole conversation. This repository still develops against 0.1.1, whose
 *  DiffBlock ignores the prop, so the installed build cannot catch a regression
 *  here: the stub below stands in for the 0.1.2 contract instead. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

interface DiffCardLabels {
  copy: string
  copied: string
  collapse: string
  collapseAria: string
  expand: (hidden: number) => string
  expandAria: (hidden: number) => string
  files: (count: number) => string
}

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  // Reads every label the 0.1.2 card reads, in the same during-render way.
  DiffBlock: ({ labels }: { labels: DiffCardLabels }) => (
    <div data-diff="">{[
      labels.copy, labels.copied, labels.collapse, labels.collapseAria,
      labels.expand(3), labels.expandAria(3), labels.files(1),
    ].join('|')}</div>
  ),
  DisclosureRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MarkdownText: () => null,
  StateDot: () => null,
  IconApiOutline14: () => null,
  IconThinkOutline14: () => null,
}))

const { ClaudeTranscriptToolItem } = await import('../src/client/ClaudeActivityNode.tsx')
const { en } = await import('../src/client/locales.ts')

const t = ((key: keyof typeof en, params?: Record<string, unknown>) => {
  const copy = en[key]
  return params === undefined ? copy : copy.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name]))
}) as never

describe('diff card labels', () => {
  it('supplies every string the 0.1.2 diff card reads while rendering', () => {
    const markup = renderToStaticMarkup(<ClaudeTranscriptToolItem t={t} tool={{
      toolUseId: 'call-1',
      toolName: 'Edit',
      description: 'Edited /tmp/x',
      subcalls: [],
      diffs: [{ path: '/tmp/x', oldText: 'before\n', newText: 'after\n' }],
    }} />)

    expect(markup).toContain(en.markdownCopy)
    expect(markup).toContain(en.markdownCopied)
    expect(markup).toContain(en.diffCardCollapse)
    expect(markup).toContain('Show 3 more lines')
    expect(markup).toContain('1 files')
    expect(markup).not.toContain('undefined')
  })
})
