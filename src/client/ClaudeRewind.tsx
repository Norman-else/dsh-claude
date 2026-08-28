import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { isRewound, type ClaudeRewindRange } from '../rewind.ts'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from './projection.ts'
import {
  locateClaudeRewindSeats,
  removeClaudeRewindSeats,
  rewindHiddenCss,
  sameClaudeRewindSeats,
  type ClaudeRewindSeat,
} from './rewind-dom.ts'
import { rewindSession } from './rewind-api.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import * as styles from './styles.ts'

/** The chat facts this control needs, read structurally so the package keeps
 *  its distance from the Host's conversation types. */
export interface ClaudeChatNodeView {
  readonly key: string
  readonly anchorSeq: number
  readonly kind: string
  readonly data?: unknown
}

export interface ClaudeChatView {
  readonly chat: {
    readonly order: readonly string[]
    readonly nodes: { get(key: string): ClaudeChatNodeView | undefined }
  }
  readonly running: boolean
}

export interface ClaudeChatSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): ClaudeChatView
}

export interface ClaudeRewindInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** The session whose conversation is on screen. */
  currentSessionId: () => string | undefined
  /** Selection changes; the control follows the visible session. */
  subscribeSessions: (listener: () => void) => () => void
  /** Conversation snapshot source of one session (node keys, seqs, content). */
  chatOf: (sessionId: string) => ClaudeChatSource | undefined
  /** Plugin projection: session ownership plus the rewound seq ranges. */
  projectionOf: (sessionId: string) => {
    subscribe(listener: () => void): () => void
    getSnapshot(): ClaudeClientProjection
  }
  /** Put the removed message back in the composer, ready to be edited and resent. */
  setDraft?: (sessionId: string, text: string) => void
}

interface RewindTarget {
  readonly seq: number
  readonly text: string
  /** Rows removed alongside it, for the confirmation copy. */
  readonly rows: number
}

const EMPTY_RANGES: readonly ClaudeRewindRange[] = []
const EMPTY_CHAT: ClaudeChatView = { chat: { order: [], nodes: { get: () => undefined } }, running: false }
const NO_SUBSCRIBE = (): (() => void) => () => {}
const EMPTY_CHAT_SNAPSHOT = (): ClaudeChatView => EMPTY_CHAT
const EMPTY_PROJECTION_SNAPSHOT = (): ClaudeClientProjection => EMPTY_CLAUDE_PROJECTION

/** Plain text of one user message node, matching what the copy action yields. */
export function rewindMessageText(data: unknown): string {
  const content = (data as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const item = block as { type?: unknown; text?: unknown }
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .join('')
}

function RewindIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

/** "Rewind to here" on every user message of a Claude session: drops that
 *  message and everything below it, and rewinds Claude's own context with it. */
export function ClaudeRewind({ t, currentSessionId, subscribeSessions, chatOf, projectionOf, setDraft }: ClaudeRewindInjected) {
  const sessionId = useSyncExternalStore(subscribeSessions, currentSessionId, currentSessionId)
  const chat = sessionId === undefined ? undefined : chatOf(sessionId)
  // Bound through closures: the session face is a class instance, so its
  // reader methods must not be detached.
  const chatStore = useMemo(() => (chat === undefined
    ? { subscribe: NO_SUBSCRIBE, getSnapshot: EMPTY_CHAT_SNAPSHOT }
    : { subscribe: (listener: () => void) => chat.subscribe(listener), getSnapshot: () => chat.getSnapshot() }), [chat])
  const snapshot = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, EMPTY_CHAT_SNAPSHOT)
  const source = sessionId === undefined ? undefined : projectionOf(sessionId)
  const projectionStore = useMemo(() => (source === undefined
    ? { subscribe: NO_SUBSCRIBE, getSnapshot: EMPTY_PROJECTION_SNAPSHOT }
    : { subscribe: (listener: () => void) => source.subscribe(listener), getSnapshot: () => source.getSnapshot() }), [source])
  const projection = useSyncExternalStore(projectionStore.subscribe, projectionStore.getSnapshot, EMPTY_PROJECTION_SNAPSHOT)
  const [seats, setSeats] = useState<readonly ClaudeRewindSeat[]>([])
  const [target, setTarget] = useState<RewindTarget>()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  const ranges = projection.rewind?.ranges ?? EMPTY_RANGES
  const owned = projection.owned
  // A rewind mid-turn would cut the running turn in half; the Host refuses it
  // and so does the control.
  const armed = sessionId !== undefined && owned && !snapshot.running

  const { hiddenKeys, targets } = useMemo(() => {
    const hidden: string[] = []
    const visible = new Map<string, RewindTarget>()
    const users: { key: string; seq: number; text: string; index: number }[] = []
    let position = 0
    for (const key of snapshot.chat.order) {
      const node = snapshot.chat.nodes.get(key)
      if (node === undefined) continue
      if (isRewound(ranges, node.anchorSeq)) {
        hidden.push(key)
        continue
      }
      position += 1
      if (node.kind === 'user') users.push({ key, seq: node.anchorSeq, text: rewindMessageText(node.data), index: position })
    }
    const total = position
    for (const user of users) visible.set(user.key, { seq: user.seq, text: user.text, rows: total - user.index })
    return { hiddenKeys: hidden, targets: visible }
  }, [snapshot, ranges])

  useEffect(() => {
    if (!armed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      removeClaudeRewindSeats()
      setSeats([])
      return
    }
    let scheduled = false
    const reconcile = (): void => {
      scheduled = false
      const found = locateClaudeRewindSeats()
      setSeats(current => (sameClaudeRewindSeats(current, found) ? current : found))
    }
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(reconcile)
    }
    reconcile()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      removeClaudeRewindSeats()
    }
  }, [armed, sessionId])

  // A session switch invalidates any open confirmation.
  useEffect(() => {
    setTarget(undefined)
    setSubmitting(false)
    setError(undefined)
  }, [sessionId])

  if (sessionId === undefined || !owned) return <span data-dsh-claude-rewind-armed="armed" hidden />

  const close = (): void => {
    if (submitting) return
    setTarget(undefined)
    setError(undefined)
  }
  const confirm = (): void => {
    if (target === undefined || submitting) return
    setSubmitting(true)
    setError(undefined)
    void rewindSession(sessionId, target.seq).then(() => {
      setSubmitting(false)
      setTarget(undefined)
      if (target.text !== '') setDraft?.(sessionId, target.text)
    }, (reason: unknown) => {
      setSubmitting(false)
      const code = reason instanceof Error && reason.message !== '' ? reason.message : 'unknown'
      setError(code === 'session-busy' ? t('rewindBusy')
        : code === 'route-missing' ? t('rewindStale')
        : t('rewindFailed', { code }))
    })
  }

  return (
    <>
      <style data-dsh-claude-rewind-styles>{`${styles.rewindActionCss}${rewindHiddenCss(hiddenKeys)}`}</style>
      {seats.map(seat => {
        const entry = targets.get(seat.key)
        if (entry === undefined) return null
        return createPortal((
          <Tooltip label={t('rewindTooltip')} side="bottom" delayMs={300}>
            <button type="button" aria-label={t('rewindTooltip')} onClick={() => { setTarget(entry) }}>
              <RewindIcon />
            </button>
          </Tooltip>
        ), seat.host, seat.key)
      })}
      {target === undefined ? null : <style data-dsh-claude-rewind-modal-styles>{styles.diffModalCss}</style>}
      <Modal
        className="dshClaudeRepositoryActionModal"
        contentClassName="dshClaudeRepositoryActionModalContent"
        open={target !== undefined}
        onClose={close}
        title={t('rewindTitle')}
        closeLabel={t('diffCancel')}
        description={t('rewindDescription', { count: target?.rows ?? 0 })}
        footer={
          <div style={styles.diffModalFooter}>
            <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} disabled={submitting} onClick={close}>{t('diffCancel')}</button>
            <button type="button" style={{ ...styles.rewindDangerButton, ...styles.diffModalButton }} disabled={submitting} onClick={confirm}>{submitting ? t('rewindSubmitting') : t('rewindConfirm')}</button>
          </div>
        }
      >
        {target === undefined ? null : <div style={styles.diffModalBody}>
          {target.text === '' ? null : <p style={styles.rewindModalMessage}>{target.text.slice(0, 2_000)}</p>}
          <p style={styles.diffModalStatus}>{t('rewindHint')}</p>
          {error === undefined ? null : <p style={styles.diffModalError}>{error}</p>}
        </div>}
      </Modal>
    </>
  )
}
