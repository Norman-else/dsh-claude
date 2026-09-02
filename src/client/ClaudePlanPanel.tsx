import { useCallback, useEffect, useRef, useState } from 'react'
import { IconCloseOutline16, IconFullscreenOutline16, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import { ClaudeMarkdown, useClaudeMarkdownLabels } from './markdown-labels.tsx'
import * as styles from './styles.ts'
import { sendPlanForChanges, type PlanNote } from './plan-feedback-api.ts'

export interface ClaudePlanPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  sessionId: string
  closeDetails: () => void
  /** Whether the panel is drawn in the shell overlay rather than the column. */
  maximized: boolean
  toggleMaximized: () => void
}

export interface ClaudePlanPanelProps extends ClaudePlanPanelInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  /** Seam for tests; defaults to the host route that answers the approval. */
  submitChanges?: typeof sendPlanForChanges
}

const PLAN_TOOL = 'ExitPlanMode'

export type PlanState = 'pending' | 'approved' | 'rejected'

export interface PlanReview {
  readonly toolUseId: string
  readonly plan: string
  readonly state: PlanState
}

/** Every plan this session handed over, oldest first, each with where its
 *  approval stands.
 *
 *  The permission bridge writes one `started` record carrying the plan and,
 *  once the user decides, a second record under the same `toolUseId` whose
 *  phase says which way it went. Both arrive on the ordinary activity stream,
 *  so the panel needs no channel of its own — it reads the transcript the
 *  session already has. */
export function planReviews(activities: readonly ClaudeActivityEvent[]): readonly PlanReview[] {
  const plans = new Map<string, string>()
  const states = new Map<string, PlanState>()
  for (const activity of activities) {
    const { toolUseId } = activity
    if (activity.kind !== 'permission' || toolUseId === undefined) continue
    if (activity.toolName === PLAN_TOOL && activity.phase === 'started' && activity.text !== undefined && activity.text.length > 0) {
      plans.set(toolUseId, activity.text)
      if (!states.has(toolUseId)) states.set(toolUseId, 'pending')
    }
    // A `failed` record means the approval could not be recorded at all, which
    // is a denial to Claude and reads as one here.
    if (activity.phase === 'completed') states.set(toolUseId, 'approved')
    else if (activity.phase === 'denied' || activity.phase === 'failed') states.set(toolUseId, 'rejected')
  }
  // Insertion order is proposal order: a Map keeps the order its keys first
  // arrived, and a re-proposal under a fresh tool use appends rather than
  // reorders.
  return [...plans].map(([toolUseId, plan]) => ({ toolUseId, plan, state: states.get(toolUseId) ?? 'pending' }))
}

/** The newest plan, for readers that only care what is on the table now. */
export function latestPlanReview(activities: readonly ClaudeActivityEvent[]): PlanReview | undefined {
  return planReviews(activities).at(-1)
}

/** A plan's own first heading, so a list of several can name them.
 *
 *  Falls back to the opening line: a plan without a heading is unusual but
 *  still has to be pickable. Fenced blocks are not scanned — a `#` comment in
 *  the first code block of a heading-less plan is a worse label than the first
 *  line, but not a wrong one, and the cost of getting it exactly right is a
 *  fence-state machine for a fallback. */
export function planTitle(plan: string): string {
  for (const raw of plan.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const heading = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line)
    if (heading?.[1] !== undefined) return heading[1].slice(0, MAX_TITLE_CHARS)
    return line.slice(0, MAX_TITLE_CHARS)
  }
  return ''
}

const MAX_TITLE_CHARS = 80
const MAX_QUOTE_CHARS = 1_000

/** The passage under the current selection, when it lies inside the plan body.
 *
 *  Reads the live selection rather than mirroring the DOM: the body is the
 *  Host's Markdown output, which this package renders but does not own, and
 *  the only stable thing about it is that it is inside this element. */
export function quotedSelection(selection: Selection | null, body: Node | null): string | undefined {
  if (selection === null || body === null || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return undefined
  const text = selection.toString().trim()
  return text.length === 0 ? undefined : text.slice(0, MAX_QUOTE_CHARS)
}

/** The newest review as one primitive, for readers that only need to know
 *  whether it changed. A snapshot hook keeps its value only while the
 *  selection compares equal, and a fresh object per snapshot would defeat
 *  that. Empty string when the session has proposed nothing. */
export function planReviewKey(activities: readonly ClaudeActivityEvent[]): string {
  const review = latestPlanReview(activities)
  return review === undefined ? '' : `${review.state}:${review.toolUseId}`
}

/** Split what {@link planReviewKey} joined. */
export function parsePlanReviewKey(key: string): { state: PlanState; toolUseId: string } | undefined {
  const cut = key.indexOf(':')
  if (cut < 0) return undefined
  const state = key.slice(0, cut)
  if (state !== 'pending' && state !== 'approved' && state !== 'rejected') return undefined
  return { state, toolUseId: key.slice(cut + 1) }
}

/** Restore-from-maximized: four corners pulling inward. Mirrors the diff
 *  panel's own, which the primitives set has no counterpart for. */
function RestorePanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 5h3V2h1.4v4.4H1.5V5Zm9.9-3h1.4v3h3v1.4h-4.4V2ZM1.5 9.6h4.4V14H4.5v-3h-3V9.6Zm9.9 0h4.4V11h-3v3h-1.4V9.6Z" />
    </svg>
  )
}

/** Card and rows reproduce the primitives' menu surface, like the session
 *  menu next door: r7, inverted hairline, shadow-lv3, 2px inset. */
const PICKER_CSS = [
  '.dsh-claude-plan-picker-root{position:relative;display:inline-flex;min-width:0}',
  '.dsh-claude-plan-picker{display:inline-flex;align-items:center;gap:4px;min-width:0;padding:2px 6px;',
    'margin:-2px -6px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer;',
    'transition:background .12s ease}',
  '.dsh-claude-plan-picker:hover,.dsh-claude-plan-picker[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-claude-plan-picker:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-claude-plan-picker>svg{flex:none;transition:transform .12s ease}',
  '.dsh-claude-plan-picker[aria-expanded="true"]>svg{transform:rotate(180deg)}',
  '.dsh-claude-plan-picker-card{box-sizing:border-box;position:absolute;top:calc(100% + 6px);left:-6px;z-index:100;',
    'display:flex;flex-direction:column;gap:1px;padding:2px;min-width:240px;max-width:min(420px,70vw);',
    'max-height:min(320px,50vh);overflow-y:auto;border:1px solid var(--dsw-alias-border-inverted);',
    'border-radius:7px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3)}',
  '.dsh-claude-plan-picker-item{display:flex;align-items:center;gap:8px;width:100%;min-height:26px;',
    'padding:5px 8px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);',
    'font:inherit;font-size:12px;line-height:17px;text-align:left;cursor:pointer}',
  '.dsh-claude-plan-picker-item:hover,.dsh-claude-plan-picker-item:focus-visible{outline:none;',
    'background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-claude-plan-picker-item[aria-current="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
  // The title takes the room the state chip does not; a long heading ellipsizes
  // rather than wrapping a menu row to two lines.
  '.dsh-claude-plan-picker-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-claude-plan-picker-ordinal{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
].join('')

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="m3 4.75 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const STATE_LABEL: Record<PlanState, ClaudeCodeSettingsKey> = {
  pending: 'planPending',
  approved: 'planApproved',
  rejected: 'planRejected',
}

/** The plan behind an `ExitPlanMode` approval, as the document it was written
 *  as. The decision itself stays with the Host's approval dialog; this panel
 *  is where the plan is actually read, under the reader's own prose palette. */
export function ClaudePlanPanel({ useClaudeProjection, t, sessionId, closeDetails, maximized, toggleMaximized, submitChanges = sendPlanForChanges }: ClaudePlanPanelProps) {
  const markdownLabels = useClaudeMarkdownLabels(t)
  const owned = useClaudeProjection(projection => projection.owned)
  const activities = useClaudeProjection(projection => projection.activities)
  const reviews = planReviews(activities)
  const [chosen, setChosen] = useState<string>()
  const [open, setOpen] = useState(false)
  const picker = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(picker, open, next => { if (!next) setOpen(false) })
  // A plan waiting on a decision outranks whatever the reader had picked: it
  // is the one thing on screen that needs them. Keyed on its identity, so the
  // override lands once per proposal and the reader can then browse freely.
  const pendingId = reviews.find(item => item.state === 'pending')?.toolUseId
  useEffect(() => {
    if (pendingId !== undefined) setChosen(pendingId)
  }, [pendingId])
  const review = reviews.find(item => item.toolUseId === chosen) ?? reviews.at(-1)
  const [notes, setNotes] = useState<readonly PlanNote[]>([])
  const [draft, setDraft] = useState('')
  const [quote, setQuote] = useState<string>()
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<'planSettled' | 'planFeedbackFailed'>()
  const body = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  // A selection inside the plan becomes the quote the next note hangs off.
  // Watched rather than captured on a button press: by the time a toolbar
  // button takes focus the selection is already gone.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const read = (): void => {
      const selected = quotedSelection(document.getSelection(), body.current)
      if (selected !== undefined) setQuote(selected)
    }
    document.addEventListener('selectionchange', read)
    return () => { document.removeEventListener('selectionchange', read) }
  }, [])
  // Notes belong to the plan they were written about.
  useEffect(() => {
    setNotes([])
    setDraft('')
    setQuote(undefined)
    setFailure(undefined)
  }, [review?.toolUseId])
  const addNote = useCallback((): void => {
    const text = draft.trim()
    if (text.length === 0) return
    setNotes(current => [...current, quote === undefined ? { text } : { quote, text }])
    setDraft('')
    setQuote(undefined)
  }, [draft, quote])
  const send = useCallback((): void => {
    if (review === undefined || sending) return
    const text = draft.trim()
    // Whatever is still in the box counts: nobody expects to have to press
    // "add" before "send".
    const pending = text.length === 0 ? notes : [...notes, quote === undefined ? { text } : { quote, text }]
    if (pending.length === 0) return
    setSending(true)
    setFailure(undefined)
    void submitChanges(sessionId, review.toolUseId, pending).then(() => {
      setNotes([])
      setDraft('')
      setQuote(undefined)
      setSending(false)
    }, (error: unknown) => {
      // The notes stay in the panel: the reviewer wrote them and the send is
      // what failed.
      setFailure(error instanceof Error && error.message === 'planSettled' ? 'planSettled' : 'planFeedbackFailed')
      setSending(false)
    })
  }, [draft, notes, quote, review, sending, sessionId, submitChanges])
  // Nothing to read means nothing to hold the details column open for.
  useEffect(() => {
    if (!owned || review === undefined) closeDetails()
  }, [closeDetails, owned, review === undefined])
  if (!owned) return null
  const index = review === undefined ? -1 : reviews.findIndex(item => item.toolUseId === review.toolUseId)
  const badge = (state: PlanState) => ({
    ...styles.planBadge,
    ...(state === 'pending' ? styles.planBadgePending : state === 'rejected' ? styles.planBadgeRejected : {}),
  })
  return (
    <div className={styles.detailsCardClass} style={{ ...styles.tasksPanel, ...(maximized ? styles.diffPanelMaximized : {}) }}>
      <style data-dsh-claude-panel-icon-styles>{styles.detailsCardCss}{styles.panelIconButtonCss}{PICKER_CSS}</style>
      <div style={styles.tasksHeader}>
        {/* Title and state read as one phrase — "Plan · awaiting approval" —
            so they share the left end. The right end is the control group. */}
        <div style={styles.planHeaderStart}>
          {reviews.length < 2 ? <span style={styles.tasksHeading}>{t('planPanelTitle')}</span> : (
            <div className="dsh-claude-plan-picker-root" ref={picker}>
              <button
                type="button"
                className="dsh-claude-plan-picker"
                aria-expanded={open}
                aria-haspopup="listbox"
                onClick={() => { setOpen(value => !value) }}
              >
                <span style={styles.tasksHeading}>{t('planPanelTitle')}</span>
                <span style={styles.planCount}>{t('planNth', { index: index + 1, total: reviews.length })}</span>
                <ChevronDownIcon />
              </button>
              {!open ? null : (
                <div className="dsh-claude-plan-picker-card" role="listbox" aria-label={t('planHistory')}>
                  {/* Newest first: the plan someone opens this list for is
                      almost always the one they just saw go by. */}
                  {[...reviews].reverse().map((item, offset) => (
                    <button
                      key={item.toolUseId}
                      type="button"
                      role="option"
                      className="dsh-claude-plan-picker-item"
                      aria-current={item.toolUseId === review?.toolUseId}
                      aria-selected={item.toolUseId === review?.toolUseId}
                      onClick={() => {
                        setChosen(item.toolUseId)
                        setOpen(false)
                      }}
                    >
                      <span className="dsh-claude-plan-picker-ordinal">{reviews.length - offset}</span>
                      <span className="dsh-claude-plan-picker-title">{planTitle(item.plan)}</span>
                      <span style={badge(item.state)}>{t(STATE_LABEL[item.state])}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {review === undefined ? null : <span style={badge(review.state)}>{t(STATE_LABEL[review.state])}</span>}
        </div>
        <div style={styles.planHeaderEnd}>
          <button type="button" className={styles.panelIconButtonClass} aria-label={maximized ? t('planRestore') : t('planMaximize')} onClick={toggleMaximized}>
            {maximized ? <RestorePanelIcon /> : <IconFullscreenOutline16 />}
          </button>
          <button type="button" className={styles.panelIconButtonClass} aria-label={t('planClose')} onClick={closeDetails}><IconCloseOutline16 /></button>
        </div>
      </div>
      <div style={styles.tasksBody} ref={body}>
        {review === undefined
          ? <p style={styles.tasksGroupEmpty}>{t('planEmpty')}</p>
          : <>
            {review.state === 'pending' ? <p style={styles.planHint}>{t('planPendingHint')}</p> : null}
            <ClaudeMarkdown key={review.toolUseId} text={review.plan} labels={markdownLabels} />
          </>}
      </div>
      {review?.state !== 'pending' ? null : (
        <div style={styles.planComposer}>
          {notes.length === 0 ? null : (
            <ul style={styles.planNoteList}>
              {notes.map((note, index) => (
                <li key={index} style={styles.planNote}>
                  {note.quote === undefined ? null : <p style={styles.planNoteQuote}>{note.quote}</p>}
                  <p style={styles.planNoteText}>{note.text}</p>
                  <button
                    type="button"
                    style={styles.planNoteRemove}
                    aria-label={t('planNoteRemove')}
                    onClick={() => { setNotes(current => current.filter((_, at) => at !== index)) }}
                  >×</button>
                </li>
              ))}
            </ul>
          )}
          {quote === undefined ? null : (
            <div style={styles.planQuoteChip}>
              <span style={styles.planNoteQuote}>{quote}</span>
              <button type="button" style={styles.planNoteRemove} aria-label={t('planQuoteClear')} onClick={() => { setQuote(undefined) }}>×</button>
            </div>
          )}
          <textarea
            ref={composer}
            value={draft}
            placeholder={t(quote === undefined ? 'planNotePlaceholder' : 'planNoteQuotedPlaceholder')}
            style={styles.planComposerInput}
            onChange={event => { setDraft(event.currentTarget.value) }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              // Enter files the note, Cmd/Ctrl+Enter sends everything: the
              // common case is several notes, so the plain key is the one that
              // keeps you writing.
              event.preventDefault()
              if (event.metaKey || event.ctrlKey) send()
              else addNote()
            }}
          />
          {failure === undefined ? null : <p role="alert" style={styles.planComposerError}>{t(failure)}</p>}
          <div style={styles.planComposerActions}>
            <span style={styles.planComposerHint}>{t('planNoteHint')}</span>
            <button
              type="button"
              style={{ ...styles.askButton, ...styles.askPrimaryButton }}
              disabled={sending || (notes.length === 0 && draft.trim().length === 0)}
              onClick={send}
            >{t(sending ? 'planSending' : 'planSendForChanges')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
