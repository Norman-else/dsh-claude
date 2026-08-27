import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MarkdownText, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { askAboutSelection } from './ask-api.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import * as styles from './styles.ts'

export interface ClaudeSelectionAskInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** The session whose conversation is on screen. */
  currentSessionId: () => string | undefined
  /** Whether the plugin owns that session (the ask query needs a Claude cwd). */
  ownsSession: (sessionId: string) => boolean
  /** Append text to the session composer without submitting. */
  insertIntoChat?: (sessionId: string, text: string) => void
}

interface SelectionRect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly bottom: number
}

interface SelectionInfo {
  readonly sessionId: string
  readonly text: string
  readonly context: string
  readonly rect: SelectionRect
  /** Live range: re-measured on scroll and painted via the Highlight API. */
  readonly range: Range
}

// Chat rows carry data-chat-flow-kind; Claude output renders under plugin
// node kinds (claude-activity-step, …) as well as the Host 'assistant' kind,
// so match any chat node that is not the user's own message.
const CHAT_NODE = '[data-chat-flow-kind]'
const USER_KIND = 'user'
const MAX_SELECTION_CHARS = 8_000
const MAX_CONTEXT_CHARS = 16_000
const POPUP_WIDTH = 560
const POPUP_ESTIMATED_HEIGHT = 320
const TOOLBAR_WIDTH = 64
const HIGHLIGHT_NAME = 'dsh-claude-ask'

function rectOf(range: Range): SelectionRect {
  const rect = range.getBoundingClientRect()
  return { top: rect.top, left: rect.left, width: rect.width, bottom: rect.bottom }
}

/** Read the current selection when it sits inside an assistant reply. */
export function selectionInfoOf(selection: Selection | null, sessionId: string | undefined): Omit<SelectionInfo, 'sessionId'> | undefined {
  if (sessionId === undefined || selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  // A whole-line (triple-click) selection ends at the start of the NEXT chat
  // row, so the common ancestor climbs above any row; anchor on the start
  // node instead and fall back to the end node.
  const hostOf = (node: Node | null): HTMLElement | null => {
    const element = node instanceof Element ? node : node?.parentElement ?? null
    return element?.closest<HTMLElement>(CHAT_NODE) ?? null
  }
  const host = hostOf(range.startContainer) ?? hostOf(range.endContainer)
  if (host === null || host.dataset.chatFlowKind === USER_KIND) return undefined
  const text = selection.toString().trim()
  if (text.length === 0) return undefined
  return {
    text: text.slice(0, MAX_SELECTION_CHARS),
    context: (host.textContent ?? '').trim().slice(0, MAX_CONTEXT_CHARS),
    rect: rectOf(range),
    range: range.cloneRange(),
  }
}

export function toolbarPosition(rect: SelectionRect, viewportWidth: number): { top: number; left: number } {
  return {
    top: Math.max(8, rect.top - 40),
    left: Math.min(Math.max(8, rect.left + rect.width / 2 - TOOLBAR_WIDTH / 2), Math.max(8, viewportWidth - TOOLBAR_WIDTH - 8)),
  }
}

/** Below the selection when it fits, else above it; never over the text unless
 *  neither side has room. */
export function popupPosition(rect: SelectionRect, viewportWidth: number, viewportHeight: number, height = POPUP_ESTIMATED_HEIGHT): { top: number; left: number; width: number } {
  const width = Math.min(POPUP_WIDTH, viewportWidth - 16)
  const below = rect.bottom + 8
  const above = rect.top - 8 - height
  const top = below + height <= viewportHeight - 8 ? below : above >= 8 ? above : Math.max(8, Math.min(below, viewportHeight - height - 8))
  return { top, left: Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - width - 8)), width }
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  )
}

function AskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.75 2.75h10.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8.2l-3.2 2.9v-2.9H2.75a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1Z" />
      <path d="M6.4 6.3a1.6 1.6 0 1 1 2.3 1.5c-.5.3-.7.6-.7 1.1M8 10.6h.01" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  )
}

/** Selection toolbar over assistant replies: copy, or ask a follow-up whose
 *  answer streams into a popup rendered with the Host Markdown renderer. */
export function ClaudeSelectionAsk({ t, currentSessionId, ownsSession, insertIntoChat }: ClaudeSelectionAskInjected) {
  const [selection, setSelection] = useState<SelectionInfo>()
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [phase, setPhase] = useState<'idle' | 'answering' | 'done'>('idle')
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState<'selection' | 'answer'>()
  const [rect, setRect] = useState<SelectionRect>()
  const [popupHeight, setPopupHeight] = useState(POPUP_ESTIMATED_HEIGHT)
  const popupRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const controller = useRef<AbortController>()
  const openRef = useRef(false)
  openRef.current = open

  const close = useCallback((): void => {
    controller.current?.abort()
    controller.current = undefined
    setOpen(false)
    setSelection(undefined)
    setQuestion('')
    setAnswer('')
    setPhase('idle')
    setError(undefined)
    setCopied(undefined)
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = (): void => {
      if (openRef.current) return
      const sessionId = currentSessionId()
      if (sessionId === undefined || !ownsSession(sessionId)) {
        setSelection(undefined)
        return
      }
      const info = selectionInfoOf(document.getSelection(), sessionId)
      setSelection(info === undefined ? undefined : { sessionId, ...info })
    }
    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(update, 120)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (popupRef.current?.contains(event.target) === true || toolbarRef.current?.contains(event.target) === true) return
      if (openRef.current) close()
    }
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('mouseup', schedule)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('mouseup', schedule)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [close, currentSessionId, ownsSession])
  useEffect(() => () => controller.current?.abort(), [])
  // Follow the text: re-measure the live range on scroll and resize.
  useEffect(() => {
    setRect(selection?.rect)
    if (selection === undefined) return
    let frame: number | undefined
    const reposition = (): void => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        const next = rectOf(selection.range)
        if (next.width === 0 && next.bottom === next.top) return
        setRect(next)
      })
    }
    document.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [selection])
  // Keep the asked-about text visibly marked while the popup owns focus. The
  // Highlight API paints without touching the Host's DOM.
  useEffect(() => {
    if (!open || selection === undefined) return
    const runtime = globalThis as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (range: Range) => unknown }
    const registry = runtime.CSS?.highlights
    if (registry === undefined || runtime.Highlight === undefined) return
    registry.set(HIGHLIGHT_NAME, new runtime.Highlight(selection.range))
    return () => { registry.delete(HIGHLIGHT_NAME) }
  }, [open, selection])
  useLayoutEffect(() => {
    const element = popupRef.current
    if (!open || element === null) return
    setPopupHeight(element.offsetHeight)
  }, [open, answer, error, phase])
  useEffect(() => {
    if (copied === undefined) return
    const timer = setTimeout(() => setCopied(undefined), 1_200)
    return () => clearTimeout(timer)
  }, [copied])

  if (selection === undefined || rect === undefined) return <span data-dsh-claude-selection-ask="armed" hidden />

  const copy = (text: string, what: 'selection' | 'answer'): void => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(what) }, () => undefined)
  }
  const submit = (): void => {
    if (question.trim().length === 0 || phase === 'answering') return
    controller.current?.abort()
    const aborter = new AbortController()
    controller.current = aborter
    setAnswer('')
    setError(undefined)
    setPhase('answering')
    void askAboutSelection(selection.sessionId, { selection: selection.text, context: selection.context, question }, delta => {
      setAnswer(current => current + delta)
    }, aborter.signal).then(() => {
      if (!aborter.signal.aborted) setPhase('done')
    }, (reason: unknown) => {
      if (aborter.signal.aborted) return
      setError(reason instanceof Error ? reason.message : t('askFailed'))
      setPhase('done')
    })
  }
  const viewportWidth = typeof window === 'undefined' ? 1_280 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight

  if (!open) {
    const position = toolbarPosition(rect, viewportWidth)
    return (
      <div ref={toolbarRef} role="toolbar" aria-label={t('askToolbar')} style={{ ...styles.askToolbar, top: position.top, left: position.left }}>
        <style data-dsh-claude-ask-styles>{styles.panelIconButtonCss}</style>
        <Tooltip label={copied === 'selection' ? t('askCopied') : t('copyTooltip')} side="top" delayMs={300}>
          <button type="button" className={styles.panelIconButtonClass} aria-label={t('copyTooltip')} onMouseDown={event => { event.preventDefault() }} onClick={() => { copy(selection.text, 'selection') }}>
            {copied === 'selection' ? <CheckIcon /> : <CopyIcon />}
          </button>
        </Tooltip>
        <Tooltip label={t('askTooltip')} side="top" delayMs={300}>
          <button type="button" className={styles.panelIconButtonClass} aria-label={t('askTooltip')} onMouseDown={event => { event.preventDefault() }} onClick={() => { setOpen(true) }}>
            <AskIcon />
          </button>
        </Tooltip>
      </div>
    )
  }

  const position = popupPosition(rect, viewportWidth, viewportHeight, popupHeight)
  return (
    <div ref={popupRef} role="dialog" aria-label={t('askTooltip')} style={{ ...styles.askPopup, top: position.top, left: position.left, width: position.width }}>
      <style data-dsh-claude-ask-styles>{styles.panelIconButtonCss}{styles.askHighlightCss}</style>
      <p style={styles.askQuote}>{selection.text}</p>
      {phase === 'idle' ? (
        <>
          <textarea
            autoFocus
            value={question}
            placeholder={t('askPlaceholder')}
            style={styles.askTextarea}
            onChange={event => { setQuestion(event.currentTarget.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <div style={styles.askActions}>
            <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} onClick={close}>{t('askClose')}</button>
            <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} disabled={question.trim().length === 0} onClick={submit}>{t('askSubmit')}</button>
          </div>
        </>
      ) : (
        <>
          <p style={styles.askQuestion}>{question}</p>
          <div style={styles.askAnswer}>
            {answer.length === 0 && error === undefined ? <span style={styles.askStatus}>{t('askThinking')}</span> : null}
            {answer.length === 0 ? null : <MarkdownText text={answer} streaming={phase === 'answering'} />}
            {error === undefined ? null : <p role="alert" style={styles.askError}>{error}</p>}
          </div>
          <div style={styles.askActions}>
            {phase === 'answering' ? <span style={styles.askStatus}>{t('askThinking')}</span> : null}
            {answer.length === 0 ? null : (
              <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} onClick={() => { copy(answer, 'answer') }}>{copied === 'answer' ? t('askCopied') : t('askCopyAnswer')}</button>
            )}
            {answer.length === 0 || insertIntoChat === undefined ? null : (
              <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} onClick={() => {
                insertIntoChat(selection.sessionId, `> ${selection.text.replaceAll('\n', '\n> ')}\n\n**${question}**\n\n${answer}`)
                close()
              }}>{t('askSendToChat')}</button>
            )}
            <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} onClick={close}>{t('askClose')}</button>
          </div>
        </>
      )}
    </div>
  )
}
