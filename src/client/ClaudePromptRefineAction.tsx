import { useEffect, useRef, useState } from 'react'
import {
  IconLoadingOutline16,
  IconRefreshOutline16,
  IconSparkle16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { refineClaudePrompt } from './prompt-api.ts'
import * as styles from './styles.ts'

export interface ClaudePromptRefineActionInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Replace the composer text. Absent when this Host exposes no input facade,
   *  and the control then never renders — a rewrite it cannot apply is worse
   *  than no button. */
  replaceDraft?: (text: string) => void
  /** Surface a failure on the composer's own notice channel. */
  notify?: (level: 'info' | 'error', text: string) => void
}

export interface ClaudePromptRefineActionProps extends ClaudePromptRefineActionInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  /** Composer state handed down by the tool row's owner. */
  input?: { readonly draft: string }
  /** Seam for tests; defaults to the host route that asks Claude to rewrite. */
  refine?: (draft: string, cancel?: AbortSignal) => Promise<string>
}

/**
 * Rewrite the draft in place, from the composer's own tool row.
 *
 * The rewrite replaces the draft outright, which is what makes the undo state
 * load-bearing rather than a nicety: `SessionInput.setDraft` documents itself
 * as "merged into history so a seed is not an undoable step of its own", so
 * Ctrl/Cmd+Z does NOT bring the original back. Without somewhere to put it,
 * one press of this button would silently destroy a draft the user may have
 * spent minutes on. So the original is held for exactly as long as it is still
 * recoverable — until the rewrite is edited or sent — and the same button
 * offers it back over that window.
 */
export function ClaudePromptRefineAction({
  t, useClaudeProjection, input, replaceDraft, notify, refine = refineClaudePrompt,
}: ClaudePromptRefineActionProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const attempt = useRef<AbortController | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState<{ readonly original: string; readonly refined: string }>()
  useEffect(() => () => { attempt.current?.abort() }, [])

  if (!owned || replaceDraft === undefined) return null
  const draft = input?.draft ?? ''
  // The offer to undo lasts only while the rewrite is still on screen intact;
  // once the user edits or sends it, the original is no longer what they would
  // be getting back.
  const undoable = applied !== undefined && draft === applied.refined
  const label = busy ? t('promptRefineBusy') : undoable ? t('promptRefineUndo') : t('promptRefine')

  const run = (): void => {
    if (busy || draft.trim() === '') return
    setBusy(true)
    const running = new AbortController()
    attempt.current = running
    refine(draft, running.signal).then((text) => {
      if (running.signal.aborted) return
      setApplied({ original: draft, refined: text })
      replaceDraft(text)
    }, (error: unknown) => {
      if (running.signal.aborted) return
      notify?.('error', t('promptRefineFailed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { setBusy(false) })
  }
  const undo = (): void => {
    if (applied === undefined) return
    replaceDraft(applied.original)
    setApplied(undefined)
  }

  return (
    <Tooltip label={label} side="top" delayMs={250}>
      <button
        type="button"
        className={styles.promptSaveTriggerClass}
        aria-label={label}
        disabled={busy || (!undoable && draft.trim() === '')}
        onClick={undoable ? undo : run}
      >
        <style data-dsh-claude-prompt-refine-styles>{styles.promptSaveTriggerCss}</style>
        {/* Sparkle, not `IconEnhanceOutline16`: that glyph is four bare
            horizontal rules, which beside the save button's lines-and-pen
            reads as a second list rather than as a different verb. */}
        {busy
          ? <IconLoadingOutline16 size={14} className={styles.promptSpinClass} />
          : undoable
            ? <IconRefreshOutline16 size={14} className={styles.promptUndoClass} />
            : <IconSparkle16 size={14} />}
      </button>
    </Tooltip>
  )
}
