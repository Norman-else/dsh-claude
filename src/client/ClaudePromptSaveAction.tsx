import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconListPenOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudePromptView } from '../prompts.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { PluginRequestError } from './plugin-transport.ts'
import { defaultPromptName, saveClaudePrompt, suggestClaudePromptName } from './prompt-api.ts'
import * as styles from './styles.ts'

export interface ClaudePromptSaveActionInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

export interface ClaudePromptSaveActionProps extends ClaudePromptSaveActionInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  /** Composer state handed down by the tool row's owner; `draft` is the text
   *  the button offers to keep. Absent only in the inert composer. */
  input?: { readonly draft: string }
  /** Seam for tests; defaults to the host route that writes the prompt file. */
  savePrompt?: (name: string, body: string) => Promise<ClaudePromptView>
  /** Seam for tests; defaults to the host route that asks Claude for a name. */
  suggestName?: (draft: string, cancel?: AbortSignal) => Promise<string | undefined>
}


const CARD_GAP = 8
const CARD_MARGIN = 12

/**
 * Place the card above its trigger, clamped into the viewport, and dismiss it
 * on a pointer that lands outside both.
 *
 * The primitives ship `useAnchoredPosition` and `useDismissOnOutsidePointer`
 * for exactly this, and both are used here through their published types —
 * but the Host's build of that package predates the `side` option of one and
 * the portal argument of the other. Neither omission is visible to `tsc`,
 * which reads this checkout's newer copy, and both are silent at runtime: the
 * card hangs below a composer pinned to the bottom of the window, and every
 * pointer landing in the naming field counts as outside and closes it. Owning
 * twenty lines beats behaviour that depends on which Desktop the plugin was
 * installed into.
 */
function useAnchoredCard(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  card: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): CSSProperties | undefined {
  const [position, setPosition] = useState<CSSProperties>()
  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined)
      return undefined
    }
    const place = (): void => {
      const trigger = anchor.current?.getBoundingClientRect()
      const panel = card.current?.getBoundingClientRect()
      if (trigger === undefined || panel === undefined) return
      const above = trigger.top - CARD_GAP - panel.height
      setPosition({
        left: Math.max(CARD_MARGIN, Math.min(trigger.left, window.innerWidth - panel.width - CARD_MARGIN)),
        // Below only when there is genuinely no room above, which for this
        // trigger means a window shorter than the card.
        top: above >= CARD_MARGIN ? above : Math.min(trigger.bottom + CARD_GAP, window.innerHeight - panel.height - CARD_MARGIN),
      })
    }
    place()
    window.addEventListener('resize', place)
    // Capture, so scrollers nested inside the page are caught too.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, card])
  useEffect(() => {
    if (!open) return undefined
    const dismiss = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (anchor.current?.contains(target) === true || card.current?.contains(target) === true) return
      onDismiss()
    }
    document.addEventListener('pointerdown', dismiss)
    return () => { document.removeEventListener('pointerdown', dismiss) }
  }, [open, anchor, card, onDismiss])
  return position
}

type Panel =
  | {
      readonly kind: 'naming'
      readonly name: string
      /** The user has taken the field over; a late suggestion must not
       *  overwrite what they are typing. */
      readonly touched: boolean
      readonly suggesting: boolean
      readonly failure?: string
    }
  | { readonly kind: 'saved'; readonly prompt: ClaudePromptView }

/**
 * Keep the draft you just wrote, from the composer's own tool row.
 *
 * It sits beside the attach and access controls rather than in a row of its
 * own: a band above the composer moves the repository bar and the composer
 * itself every time a draft appears, and this is a once-in-a-while action that
 * has not earned that. The naming card is portaled and anchored, so opening it
 * displaces nothing either.
 *
 * The field opens on a name derived from the draft's first line, which costs
 * nothing and is there instantly, and a Claude-written name replaces it when
 * one arrives. That ordering is the whole naming design: the suggestion is an
 * improvement on a working answer, never something the user waits for.
 */
export function ClaudePromptSaveAction({
  t, useClaudeProjection, input, savePrompt = saveClaudePrompt, suggestName = suggestClaudePromptName,
}: ClaudePromptSaveActionProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const anchor = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const suggestion = useRef<AbortController | undefined>(undefined)
  const [panel, setPanel] = useState<Panel>()
  const [saving, setSaving] = useState(false)
  const close = useCallback((): void => {
    suggestion.current?.abort()
    suggestion.current = undefined
    setPanel(undefined)
  }, [])
  const position = useAnchoredCard(panel !== undefined, anchor, panelRef, close)
  useEffect(() => () => { suggestion.current?.abort() }, [])

  if (!owned) return null
  const draft = input?.draft ?? ''
  const label = t('promptSave')
  const open = (): void => {
    setPanel({ kind: 'naming', name: defaultPromptName(draft), touched: false, suggesting: true })
    const attempt = new AbortController()
    suggestion.current = attempt
    void suggestName(draft, attempt.signal).then((suggested) => {
      if (attempt.signal.aborted) return
      setPanel(current => current?.kind !== 'naming'
        ? current
        : { ...current, suggesting: false, ...(suggested === undefined || current.touched ? {} : { name: suggested }) })
    })
  }
  const save = (): void => {
    const name = panel?.kind === 'naming' ? panel.name.trim() : ''
    if (saving || name === '' || draft.trim() === '') return
    setSaving(true)
    savePrompt(name, draft).then((prompt) => {
      setPanel({ kind: 'saved', prompt })
    }, (error: unknown) => {
      // A name collision is the one failure the user fixes right here, so the
      // card stays open holding what they typed.
      setPanel({
        kind: 'naming',
        name,
        touched: true,
        suggesting: false,
        failure: error instanceof PluginRequestError && error.code === 'name-taken'
          ? t('promptSaveExists')
          : t('promptSaveFailed', { message: error instanceof Error ? error.message : String(error) }),
      })
    }).finally(() => { setSaving(false) })
  }

  return (
    <span ref={anchor} style={{ position: 'relative', display: 'inline-flex' }}>
      <style data-dsh-claude-prompt-save-styles>{styles.promptSaveTriggerCss}</style>
      <Tooltip label={label} side="top" delayMs={250} disabled={panel !== undefined}>
        <button
          type="button"
          className={styles.promptSaveTriggerClass}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={panel !== undefined}
          // Nothing written, nothing to keep — the control says so by being
          // unavailable rather than by failing once pressed.
          disabled={draft.trim() === ''}
          onClick={() => { if (panel === undefined) open(); else close() }}
        ><IconListPenOutline16 size={14} /></button>
      </Tooltip>
      {panel === undefined || typeof document === 'undefined' ? null : createPortal(
        <div ref={panelRef} style={{ ...styles.promptSaveCard, ...position }} role="dialog" aria-label={label}>
          {panel.kind === 'saved' ? (
            <>
              <span>{t('promptSaved', { name: panel.prompt.name })}</span>
              <span style={styles.promptSaveLocation}>{panel.prompt.location}</span>
              <span style={styles.promptSaveActions}>
                <Button variant="primary" size="sm" onClick={close}>{t('promptSaveDone')}</Button>
              </span>
            </>
          ) : (
            <form style={{ display: 'contents' }} onSubmit={(event) => { event.preventDefault(); save() }}>
              <span style={styles.promptSaveHeading}>{panel.suggesting ? t('promptSaveNaming') : label}</span>
              <input
                className={styles.promptSaveFieldClass}
                aria-label={t('promptSaveName')}
                placeholder={t('promptSaveName')}
                value={panel.name}
                maxLength={128}
                autoFocus
                disabled={saving}
                onChange={event => setPanel({ ...panel, name: event.currentTarget.value, touched: true })}
                onKeyDown={(event) => { if (event.key === 'Escape') close() }}
              />
              {panel.failure === undefined ? null : <span style={styles.promptSaveError}>{panel.failure}</span>}
              <span style={styles.promptSaveActions}>
                <Button variant="ghost" size="sm" type="button" disabled={saving} onClick={close}>{t('promptSaveCancel')}</Button>
                <Button variant="primary" size="sm" type="submit" disabled={saving}>{t('promptSaveConfirm')}</Button>
              </span>
            </form>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}
