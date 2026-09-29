import { useEffect, useRef } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'

export interface ClaudePromptSuggestionInjected {
  /** Replace the draft with the accepted suggestion; the Host puts the caret
   *  at its end. Absent when the session has no composer to write into. */
  acceptDraft?: (text: string) => void
  /** Report the composer DOM this relies on going missing after a Host upgrade. */
  report?: (detail: string) => void
}

export interface ClaudePromptSuggestionProps extends ClaudePromptSuggestionInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  useInput: SnapshotSelectorHook<{ readonly draft: string }>
}

/** What is left to ghost after the draft, or undefined when nothing should be.
 *  Only a draft the suggestion still starts with keeps it: the moment the user
 *  types something else, the guess is wrong and goes away. A `/` draft is left
 *  to the command menu, which owns Tab while it is open. */
export function suggestionRemainder(suggestion: string | undefined, draft: string): string | undefined {
  if (suggestion === undefined || draft.length >= suggestion.length || !suggestion.startsWith(draft)) return undefined
  if (draft.startsWith('/') || draft.endsWith('\n')) return undefined
  return suggestion.slice(draft.length)
}

/** Whether the caret sits after the last character of `root`. */
function caretAtEnd(root: Element): boolean {
  const selection = root.ownerDocument.getSelection()
  if (selection === null || !selection.isCollapsed || selection.focusNode === null || !root.contains(selection.focusNode)) return false
  const rest = root.ownerDocument.createRange()
  rest.selectNodeContents(root)
  rest.setStart(selection.focusNode, selection.focusOffset)
  return rest.toString().length === 0
}

/**
 * Claude Code's guess at the next prompt, drawn as grey text after the draft;
 * Tab, or → with the caret at the end, takes it.
 *
 * The Host composer has no ghost-text API, but it already draws its command
 * hints as a `::after` on the last paragraph. This does the same under its own
 * attribute and custom property, set on the editor's wrapper so the
 * placeholder (a sibling of the editor) can read it too: an empty draft shows
 * the suggestion in the placeholder's seat instead. The text therefore wraps
 * and scrolls exactly like the draft, and nothing is positioned by hand.
 */
export function ClaudePromptSuggestion({ useClaudeProjection, useInput, acceptDraft, report }: ClaudePromptSuggestionProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const suggestion = useClaudeProjection(projection => projection.promptSuggestion)
  const draft = useInput(state => state.draft)
  const anchor = useRef<HTMLSpanElement>(null)
  const remainder = owned && acceptDraft !== undefined ? suggestionRemainder(suggestion, draft) : undefined

  useEffect(() => {
    if (remainder === undefined || suggestion === undefined || acceptDraft === undefined) return undefined
    const input = anchor.current?.closest('[data-composer-card]')?.querySelector<HTMLElement>('[data-composer-input]')
    const wrapper = input?.parentElement
    if (input === undefined || input === null || wrapper === undefined || wrapper === null) {
      report?.('composer input not found: [data-composer-card] [data-composer-input]; prompt suggestions are not drawn')
      return undefined
    }
    wrapper.setAttribute(styles.promptSuggestionAttribute, draft === '' ? 'empty' : 'inline')
    wrapper.style.setProperty(styles.promptSuggestionProperty, JSON.stringify(remainder))
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' && event.key !== 'ArrowRight') return
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (!(event.target instanceof Node) || !input.contains(event.target)) return
      if (input.hasAttribute('data-composer-composing')) return
      if (event.key === 'ArrowRight' && !caretAtEnd(input)) return
      // Capture on the document runs before the editor's own key handling.
      event.preventDefault()
      event.stopPropagation()
      acceptDraft(suggestion)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      wrapper.removeAttribute(styles.promptSuggestionAttribute)
      wrapper.style.removeProperty(styles.promptSuggestionProperty)
    }
  }, [remainder, suggestion, draft, acceptDraft, report])

  return (
    <span ref={anchor} hidden>
      <style data-dsh-claude-prompt-suggestion-styles>{styles.promptSuggestionCss}</style>
    </span>
  )
}
