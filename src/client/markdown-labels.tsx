import { useMemo } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClaudeCodeSettingsKey } from './locales.ts'

/** Localized Markdown chrome the Host's renderer requires.
 *
 *  Desktop 2.0 replaced MarkdownText's optional `codeLabels` with a mandatory
 *  `labels` object and gave it no default: the code-block branch reads
 *  `labels.code.copyLabel` directly, so a missing object throws the moment a
 *  fenced block appears and the Slot entry — the whole Chat node — goes down
 *  with it. */
export interface ClaudeMarkdownLabels {
  code: { copyLabel: string; copiedLabel: string }
  footnotes: string
}

/** Stable across renders: MarkdownText keys its streaming renderer on this
 *  object's identity and reparses from scratch whenever it changes. */
export function useClaudeMarkdownLabels(
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string,
): ClaudeMarkdownLabels {
  return useMemo(() => ({
    code: { copyLabel: t('markdownCopy'), copiedLabel: t('markdownCopied') },
    footnotes: t('markdownFootnotes'),
  }), [t])
}

/** MarkdownText with the labels the running Host demands.
 *
 *  The published primitives package still types the old `codeLabels` prop, so
 *  the new shape cannot typecheck against it — the cast is confined here rather
 *  than repeated at every call site. Drop it once the installed
 *  @deepseek-ai/dsh-client-ui-primitives matches the Desktop build. */
export function ClaudeMarkdown({ text, labels, streaming }: {
  text: string
  labels: ClaudeMarkdownLabels
  streaming?: boolean
}) {
  const props = { text, labels, ...(streaming === undefined ? {} : { streaming }) }
  const Renderer = MarkdownText as unknown as (input: typeof props) => JSX.Element
  return <Renderer {...props} />
}
