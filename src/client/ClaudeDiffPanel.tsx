import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutline14,
  IconCloseOutline16,
  IconFullscreenOutline16,
  Menu,
  Modal,
  Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepositoryActionKind, RepositoryActionPreview } from '../repository-actions.ts'
import type { RepositoryStatus } from '../repository-status.ts'
import type { ReviewComment, ReviewCommentSide } from '../review-comments.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import { executeRepositoryAction, generateCommitMessage, loadRepositoryActionPreview } from './repository-action-api.ts'
import { composeCommentsPrompt, loadPullRequestComments, type PullRequestReviewComment } from './pr-feedback-api.ts'
import { addReviewComment, removeReviewComment } from './review-comment-api.ts'
import { loadRepositoryFileLines } from './repository-setup-api.ts'
import { renderCommentBody } from './comment-markdown.ts'
import { commentLineLabel } from './ClaudeReviewComments.tsx'
import * as styles from './styles.ts'

export interface ClaudeDiffPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  sessionId: string
  maximized: boolean
  closeDetails: () => void
  toggleMaximized: () => void
  /** Submit the composer, seeding the given draft text when it is empty. */
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}

export interface ClaudeDiffPanelProps extends ClaudeDiffPanelInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

export interface DiffFile {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly lines: readonly string[]
}

function pathFromHeader(line: string): string | undefined {
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
  return match?.[2]
}

export function parseUnifiedDiff(patch: string): readonly DiffFile[] {
  const files: DiffFile[] = []
  let path: string | undefined
  let lines: string[] = []
  const flush = (): void => {
    if (path === undefined) return
    const content = lines.filter(line => !line.startsWith('diff --git ') && !line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ '))
    files.push({
      path,
      additions: content.filter(line => line.startsWith('+')).length,
      deletions: content.filter(line => line.startsWith('-')).length,
      lines: content,
    })
  }
  for (const line of patch.split(/\r?\n/u)) {
    const nextPath = pathFromHeader(line)
    if (nextPath !== undefined) {
      flush()
      path = nextPath
      lines = [line]
    } else if (path !== undefined) lines.push(line)
  }
  flush()
  return files
}

/** A run of unmodified lines the unified diff left out; `count` is unknown for the tail of the file. */
export interface DiffGap {
  readonly oldStart: number
  readonly newStart: number
  readonly count?: number
  readonly position: 'top' | 'middle' | 'bottom'
}

export interface NumberedDiffLine {
  readonly line: string
  readonly kind: 'add' | 'delete' | 'hunk' | 'context' | 'collapsed'
  readonly oldLine?: number
  readonly newLine?: number
  readonly gap?: DiffGap
}

/** How many unmodified lines one click on an expander reveals. */
export const DIFF_EXPAND_STEP = 20

export function numberDiffLines(lines: readonly string[]): readonly NumberedDiffLine[] {
  const numbered: NumberedDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let previousOldEnd: number | undefined
  let previousNewEnd = 0
  // New and deleted files have no unmodified lines around their single hunk.
  let expandable = false
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (hunk !== null) {
      const nextOld = Number(hunk[1])
      const nextNew = Number(hunk[3])
      const oldCount = Number(hunk[2] ?? 1)
      const newCount = Number(hunk[4] ?? 1)
      if (previousOldEnd === undefined) {
        expandable = oldCount > 0 && newCount > 0
        if (expandable && nextOld > 1) numbered.push({ line: '', kind: 'collapsed', gap: { oldStart: 1, newStart: 1, count: nextOld - 1, position: 'top' } })
      } else if (nextOld > previousOldEnd) {
        numbered.push({ line: '', kind: 'collapsed', gap: { oldStart: previousOldEnd, newStart: previousNewEnd, count: nextOld - previousOldEnd, position: 'middle' } })
      }
      oldLine = nextOld
      newLine = nextNew
      previousOldEnd = nextOld + oldCount
      previousNewEnd = nextNew + newCount
      numbered.push({ line, kind: 'hunk' })
      continue
    }
    if (line.startsWith('+')) {
      numbered.push({ line, kind: 'add', newLine })
      newLine += 1
    } else if (line.startsWith('-')) {
      numbered.push({ line, kind: 'delete', oldLine })
      oldLine += 1
    } else {
      numbered.push({ line, kind: 'context', oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }
  if (expandable && previousOldEnd !== undefined) {
    numbered.push({ line: '', kind: 'collapsed', gap: { oldStart: previousOldEnd, newStart: previousNewEnd, position: 'bottom' } })
  }
  return numbered
}

/**
 * Splice revealed working-tree lines (keyed by new-side line number) into the
 * collapsed gaps. Expansion only ever grows a gap's edges, so each gap is a
 * top run + remaining gap + bottom run; `total` (file line count) turns the
 * open-ended tail gap into a bounded one.
 */
export function expandDiffRows(rows: readonly NumberedDiffLine[], revealed: ReadonlyMap<number, string>, total?: number): readonly NumberedDiffLine[] {
  const out: NumberedDiffLine[] = []
  for (const row of rows) {
    const gap = row.gap
    if (row.kind !== 'collapsed' || gap === undefined) {
      out.push(row)
      continue
    }
    const count = gap.count ?? (total === undefined ? undefined : Math.max(0, total - gap.newStart + 1))
    const context = (offset: number): NumberedDiffLine => ({
      line: ` ${revealed.get(gap.newStart + offset) ?? ''}`,
      kind: 'context',
      oldLine: gap.oldStart + offset,
      newLine: gap.newStart + offset,
    })
    let top = 0
    while ((count === undefined || top < count) && revealed.has(gap.newStart + top)) top += 1
    let bottom = 0
    if (count !== undefined) while (bottom < count - top && revealed.has(gap.newStart + count - 1 - bottom)) bottom += 1
    for (let offset = 0; offset < top; offset += 1) out.push(context(offset))
    const remaining = count === undefined ? undefined : count - top - bottom
    if (remaining === undefined || remaining > 0) {
      out.push({ ...row, gap: { ...gap, oldStart: gap.oldStart + top, newStart: gap.newStart + top, ...(remaining === undefined ? {} : { count: remaining }) } })
    }
    if (count !== undefined) for (let offset = count - bottom; offset < count; offset += 1) out.push(context(offset))
  }
  return out
}

export interface ReviewCommentAnchor {
  /** Last (anchor) line; the editor and saved comment attach here. */
  readonly line: number
  readonly side: ReviewCommentSide
  /** First line of a multi-line selection. */
  readonly startLine?: number
}

/**
 * Anchor for a drag from row `from` to row `to`: every commentable row in
 * between on the same side as the first row, collapsed to its first/last line.
 */
export function rangeCommentAnchor(anchors: readonly (ReviewCommentAnchor | undefined)[], from: number, to: number): ReviewCommentAnchor | undefined {
  const side = anchors[from]?.side
  if (side === undefined) return undefined
  const lines = anchors
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .flatMap(anchor => (anchor?.side === side ? [anchor.line] : []))
  const line = Math.max(...lines)
  const startLine = Math.min(...lines)
  return startLine < line ? { line, side, startLine } : { line, side }
}

/** Which working-tree line a comment on this rendered diff row refers to. */
export function commentAnchorForLine(entry: NumberedDiffLine): ReviewCommentAnchor | undefined {
  if (entry.kind === 'add' || entry.kind === 'context') {
    return entry.newLine === undefined ? undefined : { line: entry.newLine, side: 'new' }
  }
  if (entry.kind === 'delete') {
    return entry.oldLine === undefined ? undefined : { line: entry.oldLine, side: 'old' }
  }
  return undefined
}

function DiffLine({ entry, addLabel, selected, onComment, onDragStart, onDragEnter }: {
  entry: NumberedDiffLine
  addLabel: string
  selected: boolean
  onComment?: (() => void) | undefined
  onDragStart?: (() => void) | undefined
  onDragEnter?: (() => void) | undefined
}) {
  const style = entry.kind === 'add'
    ? styles.diffLineAdd
    : entry.kind === 'delete' ? styles.diffLineDelete : entry.kind === 'hunk' ? styles.diffLineHunk : styles.diffLineContext
  const lineNumber = entry.oldLine === undefined && entry.newLine === undefined
    ? ''
    : entry.oldLine === undefined ? String(entry.newLine) : entry.newLine === undefined ? String(entry.oldLine) : String(entry.newLine)
  return (
    <div className={styles.diffLineRowClass} style={{ ...styles.diffLine, ...style, ...(selected ? styles.diffLineSelected : {}) }} onPointerEnter={onDragEnter}>
      <button
        type="button"
        className={styles.diffCommentButtonClass}
        disabled={onComment === undefined}
        aria-label={addLabel}
        onPointerDown={event => {
          if (event.button !== 0 || onDragStart === undefined) return
          // Keep the pointer free to enter the rows below/above while dragging, and stop text selection.
          event.preventDefault()
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          onDragStart()
        }}
        onClick={event => { if (event.detail === 0) onComment?.() }}
      >+</button>
      <span style={styles.diffLineNumber}>{lineNumber}</span>
      <span style={styles.diffLineMarker}>{entry.kind === 'add' ? '+' : entry.kind === 'delete' ? '−' : ' '}</span>
      <span style={styles.diffLineText}>{entry.line.slice(entry.kind === 'hunk' ? 0 : 1)}</span>
    </div>
  )
}

function ChevronGlyph({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === 'up' ? 'M3 8.5l4-4 4 4' : 'M3 5.5l4 4 4-4'} />
    </svg>
  )
}

/** "N unmodified lines" separator with GitHub-style expanders: ↑ above the first hunk, ↑↓ between hunks, ↓ after the last. */
function DiffGapRow({ gap, t, busy, onExpand }: { gap: DiffGap; t: ClaudeDiffPanelInjected['t']; busy: boolean; onExpand?: ((gap: DiffGap, direction: 'up' | 'down') => void) | undefined }) {
  const button = (direction: 'up' | 'down'): ReactNode => (
    <button type="button" style={styles.diffGapButton} disabled={busy || onExpand === undefined} aria-label={t(direction === 'up' ? 'diffExpandUp' : 'diffExpandDown')} title={t(direction === 'up' ? 'diffExpandUp' : 'diffExpandDown')} onClick={() => onExpand?.(gap, direction)}><ChevronGlyph direction={direction} /></button>
  )
  return (
    <div style={{ ...styles.diffLine, ...styles.diffLineHunk }}>
      <span style={styles.diffGapControls}>
        {gap.position === 'bottom' ? null : button('up')}
        {gap.position === 'top' ? null : button('down')}
      </span>
      <span style={styles.diffLineText}>{gap.count === undefined ? t('diffUnmodifiedTail') : t('diffUnmodifiedLines', { count: gap.count })}</span>
    </div>
  )
}

function CommentGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 9.5a2 2 0 0 1-2 2H6l-3.5 2.5V4a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2z" />
    </svg>
  )
}

interface DiffFileSectionProps {
  readonly file: DiffFile
  /** Repository root the working tree lives in; without it unmodified lines cannot be expanded. */
  readonly root: string | undefined
  readonly initiallyOpen: boolean
  readonly t: ClaudeDiffPanelInjected['t']
  readonly comments: readonly ReviewComment[]
  readonly ghComments: readonly PullRequestReviewComment[]
  readonly editorAnchor: ReviewCommentAnchor | undefined
  readonly editorNode: ReactNode
  readonly onOpenEditor: (anchor: ReviewCommentAnchor) => void
  readonly onRemoveComment: (id: string) => void
}

function DiffFileSection({ file, root, initiallyOpen, t, comments, ghComments, editorAnchor, editorNode, onOpenEditor, onRemoveComment }: DiffFileSectionProps) {
  const [open, setOpen] = useState(initiallyOpen)
  const [revealed, setRevealed] = useState<ReadonlyMap<number, string>>(() => new Map())
  const [total, setTotal] = useState<number>()
  const [expanding, setExpanding] = useState(false)
  const [drag, setDrag] = useState<{ start: number; end: number }>()
  const rows = useMemo(() => expandDiffRows(numberDiffLines(file.lines), revealed, total), [file.lines, revealed, total])
  const anchors = useMemo(() => rows.map(commentAnchorForLine), [rows])
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  // Collapsed sections hide their comments, so the header carries the count.
  const commentCount = comments.length + ghComments.length
  const expand = (gap: DiffGap, direction: 'up' | 'down'): void => {
    if (root === undefined || expanding) return
    const span = gap.count ?? DIFF_EXPAND_STEP
    const size = Math.min(DIFF_EXPAND_STEP, span)
    const from = direction === 'down' ? gap.newStart : gap.newStart + span - size
    setExpanding(true)
    void loadRepositoryFileLines(root, file.path, from, from + size - 1).then(result => {
      setRevealed(previous => {
        const next = new Map(previous)
        result.lines.forEach((text, offset) => next.set(from + offset, text))
        return next
      })
      setTotal(result.total)
    }, () => undefined).finally(() => setExpanding(false))
  }
  useEffect(() => {
    if (drag === undefined) return
    const finish = (): void => {
      setDrag(undefined)
      const anchor = rangeCommentAnchor(anchors, drag.start, drag.end)
      if (anchor !== undefined) onOpenEditor(anchor)
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [anchors, drag, onOpenEditor])
  const dragLow = drag === undefined ? undefined : Math.min(drag.start, drag.end)
  const dragHigh = drag === undefined ? undefined : Math.max(drag.start, drag.end)
  const dragSide = drag === undefined ? undefined : anchors[drag.start]?.side
  return (
    <section style={styles.diffFile}>
      <button type="button" style={styles.diffFileHeader} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span style={{ ...styles.chevron, ...(open ? styles.chevronOpen : {}) }}>›</span>
        <span style={styles.diffFilePath}>
          <Tooltip label={file.path} side="bottom" delayMs={300} maxWidth={520}>
            <span style={styles.diffFileName} aria-label={file.path}>{name}</span>
          </Tooltip>
        </span>
        {commentCount === 0 ? null : (
          <span style={styles.diffFileComments} aria-label={t('diffFileComments', { count: commentCount })}>
            <CommentGlyph />{commentCount}
          </span>
        )}
        <span style={styles.diffFileStats}><span style={styles.diffAdd}>+{file.additions}</span><span style={styles.diffDelete}>−{file.deletions}</span></span>
      </button>
      {open ? <div style={styles.diffCode}>{rows.map((entry, index) => {
        if (entry.kind === 'collapsed' && entry.gap !== undefined) {
          return <DiffGapRow key={`gap:${entry.gap.newStart}`} gap={entry.gap} t={t} busy={expanding} onExpand={root === undefined ? undefined : expand} />
        }
        const anchor = anchors[index]
        const lineComments = anchor === undefined ? [] : comments.filter(comment => comment.line === anchor.line && comment.side === anchor.side)
        const ghLineComments = anchor === undefined ? [] : ghComments.filter(comment => comment.line === anchor.line && comment.side === anchor.side)
        const editorOpen = anchor !== undefined && editorAnchor !== undefined && editorAnchor.line === anchor.line && editorAnchor.side === anchor.side
        const inDrag = dragLow !== undefined && dragHigh !== undefined && index >= dragLow && index <= dragHigh && anchor?.side === dragSide
        const inEditorRange = anchor !== undefined && editorAnchor !== undefined && editorAnchor.side === anchor.side
          && anchor.line <= editorAnchor.line && anchor.line >= (editorAnchor.startLine ?? editorAnchor.line)
        return (
          <Fragment key={`${index}:${entry.line}`}>
            <DiffLine
              entry={entry}
              addLabel={t('reviewCommentAdd')}
              selected={inDrag || inEditorRange}
              onComment={anchor === undefined ? undefined : () => onOpenEditor(anchor)}
              onDragStart={anchor === undefined ? undefined : () => setDrag({ start: index, end: index })}
              onDragEnter={drag === undefined ? undefined : () => setDrag(current => (current === undefined ? current : { ...current, end: index }))}
            />
            {lineComments.map(comment => (
              <div key={comment.id} style={styles.diffCommentBlock}>
                <div style={styles.diffCommentCardMeta}>
                  <span>{commentLineLabel(comment, t)}</span>
                  <button type="button" style={styles.reviewCommentChipRemove} aria-label={t('reviewCommentRemove')} onClick={() => onRemoveComment(comment.id)}>×</button>
                </div>
                <p style={styles.diffCommentCardText}>{comment.text}</p>
              </div>
            ))}
            {ghLineComments.map(comment => (
              <div key={`gh-${comment.id}`} style={styles.diffCommentBlock}>
                <div style={styles.diffCommentCardMeta}>
                  <span style={styles.diffGhCommentIdentity}>
                    {comment.avatarUrl === undefined ? null : (
                      <img
                        src={comment.avatarUrl}
                        alt=""
                        width={16}
                        height={16}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        style={styles.diffGhCommentAvatar}
                        // A blocked or missing avatar must not leave a broken glyph behind.
                        onError={event => { event.currentTarget.style.display = 'none' }}
                      />
                    )}
                    <span style={styles.diffGhCommentAuthor}>@{comment.author}</span>
                  </span>
                  <a href={comment.url} target="_blank" rel="noopener noreferrer" style={styles.diffGhCommentLink} aria-label={comment.url}>↗</a>
                </div>
                <div
                  style={styles.diffCommentCardText}
                  className="dshClaudeDiffCommentBody"
                  // Sanitized against this plugin's own allowlist; see comment-markdown.ts.
                  dangerouslySetInnerHTML={{ __html: renderCommentBody(comment.body) }}
                />
              </div>
            ))}
            {editorOpen ? editorNode : null}
          </Fragment>
        )
      })}</div> : null}
    </section>
  )
}

interface ActionDialogState {
  readonly action: RepositoryActionKind
  readonly preview?: RepositoryActionPreview
  readonly loading: boolean
  readonly submitting: boolean
  readonly error?: string
  readonly commit?: string
  readonly pullRequestUrl?: string
}

export function actionLabel(action: RepositoryActionKind, t: ClaudeDiffPanelInjected['t']): string {
  const label = action === 'commit'
    ? t('diffCommit')
    : action === 'commit-push' ? t('diffCommitPush') : action === 'push' ? t('diffPush') : action === 'merge-pr' ? t('diffMergePr') : action === 'update-branch' ? t('diffUpdateBranch') : t('diffCreatePr')
  return label.replace(/[….]+$/u, '')
}

export type RepositoryActionAvailability = Readonly<Record<RepositoryActionKind, boolean>>

export function repositoryActionAvailability(
  repository: Pick<RepositoryStatus, 'status' | 'dirty' | 'detached' | 'remote' | 'pullRequest' | 'upstream' | 'ahead' | 'baseBehind'> | undefined,
): RepositoryActionAvailability {
  const ready = repository?.status === 'ready' && repository.detached !== true
  const committable = ready && repository.dirty === true
  const hasRemote = repository?.remote !== undefined
  const hasOpenPullRequest = repository?.pullRequest?.state === 'open'
  const pushable = ready && hasRemote && (repository.upstream === false || (repository.ahead ?? 0) > 0)
  return {
    'commit': committable,
    'commit-push': committable && hasRemote,
    'push': pushable,
    'create-pr': (committable || pushable) && hasRemote && !hasOpenPullRequest,
    'merge-pr': ready && hasOpenPullRequest && repository?.pullRequest?.draft !== true,
    'update-branch': ready && hasOpenPullRequest && repository?.dirty !== true && (repository?.baseBehind ?? 0) > 0,
  }
}

function RestorePanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 5h3V2h1.4v4.4H1.5V5Zm9.9-3h1.4v3h3v1.4h-4.4V2ZM1.5 9.6h4.4V14H4.5v-3h-3V9.6Zm9.9 0h4.4V11h-3v3h-1.4V9.6Z" />
    </svg>
  )
}

export function ClaudeDiffPanel({ useClaudeProjection, t, sessionId, maximized, closeDetails, toggleMaximized, submitPrompt }: ClaudeDiffPanelProps) {
  const projection = useClaudeProjection(value => value)
  const repository = projection.repository
  const diff = repository?.diff
  const files = useMemo(() => parseUnifiedDiff(diff?.patch ?? ''), [diff?.patch])
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<ActionDialogState>()
  const [message, setMessage] = useState('')
  const [includeUnstaged, setIncludeUnstaged] = useState(true)
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [draft, setDraft] = useState(true)
  const [commentEditor, setCommentEditor] = useState<{ path: string } & ReviewCommentAnchor>()
  const [commentDraft, setCommentDraft] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentError, setCommentError] = useState<string>()
  const [localComments, setLocalComments] = useState<readonly ReviewComment[]>([])
  const [removedCommentIds, setRemovedCommentIds] = useState<ReadonlySet<string>>(() => new Set())
  const actionController = useRef<AbortController>()
  const [ghComments, setGhComments] = useState<readonly PullRequestReviewComment[]>([])
  const pullNumber = repository?.pullRequest?.state === 'open' ? repository.pullRequest.number : undefined
  useEffect(() => {
    setGhComments([])
    if (pullNumber === undefined) return
    const controller = new AbortController()
    void loadPullRequestComments(sessionId, pullNumber, controller.signal).then(setGhComments, () => undefined)
    return () => { controller.abort() }
  }, [pullNumber, sessionId])
  // The code container is max-content wide for horizontal scrolling; comment
  // editors size against the visible width published through this variable.
  const diffViewportObserver = useRef<ResizeObserver>()
  const diffBodyRef = useCallback((element: HTMLDivElement | null) => {
    diffViewportObserver.current?.disconnect()
    diffViewportObserver.current = undefined
    if (element === null || typeof ResizeObserver === 'undefined') return
    const update = (): void => element.style.setProperty('--dsh-claude-diff-viewport', `${element.clientWidth}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    diffViewportObserver.current = observer
  }, [])
  useEffect(() => () => diffViewportObserver.current?.disconnect(), [])
  const closeDialog = useCallback(() => {
    if (dialog?.submitting === true) return
    actionController.current?.abort()
    actionController.current = undefined
    setDialog(undefined)
  }, [dialog?.submitting])
  // Successful commit/push confirmations dismiss themselves after a short
  // beat; a fresh PR stays open because its link is the point of the dialog.
  useEffect(() => {
    if (dialog?.commit === undefined || dialog.error !== undefined || dialog.pullRequestUrl !== undefined) return
    const timer = setTimeout(closeDialog, 1_200)
    return () => clearTimeout(timer)
  }, [closeDialog, dialog?.commit, dialog?.error, dialog?.pullRequestUrl])
  const openAction = useCallback((action: RepositoryActionKind) => {
    actionController.current?.abort()
    setMenuOpen(false)
    setDialog({ action, loading: true, submitting: false })
    setMessage('')
    setPrTitle('')
    setPrBody('')
    setBaseBranch('')
    setDraft(true)
    const controller = new AbortController()
    actionController.current = controller
    void loadRepositoryActionPreview(sessionId, controller.signal).then(async preview => {
      setIncludeUnstaged(preview.hasUnstaged || preview.hasUntracked)
      if (action === 'push') {
        setDialog({ action, preview, loading: false, submitting: false })
        return
      }
      setDialog({ action, preview, loading: true, submitting: false })
      const generated = await generateCommitMessage(sessionId, preview.fingerprint, controller.signal)
      setMessage(generated)
      setPrTitle(generated)
      setPrBody(`Summary: ${generated}\n\nChanges:\n- ${generated}`)
      setDialog({ action, preview, loading: false, submitting: false })
    }).catch(error => {
      if (!controller.signal.aborted) setDialog({ action, loading: false, submitting: false, error: error instanceof Error ? error.message : t('diffActionFailed') })
    })
  }, [sessionId, t])
  const confirm = useCallback(async () => {
    if (dialog?.preview === undefined || (dialog.action !== 'push' && message.trim().length === 0)) return
    const { error: _error, ...pending } = dialog
    setDialog({ ...pending, submitting: true })
    try {
      const result = await executeRepositoryAction(sessionId, {
        action: dialog.action,
        fingerprint: dialog.preview.fingerprint,
        message,
        includeUnstaged,
        ...(dialog.action === 'create-pr' ? { prTitle, prBody, ...(baseBranch.trim() === '' ? {} : { baseBranch }), draft } : {}),
      })
      setDialog({ ...dialog, submitting: false, commit: result.commit, ...(result.pullRequestUrl === undefined ? {} : { pullRequestUrl: result.pullRequestUrl }) })
    } catch (error) {
      const completedCommit = typeof error === 'object' && error !== null && 'commit' in error && typeof error.commit === 'string' ? error.commit : undefined
      setDialog({ ...dialog, submitting: false, error: error instanceof Error ? error.message : t('diffActionFailed'), ...(completedCommit === undefined ? {} : { commit: completedCommit }) })
    }
  }, [baseBranch, dialog, draft, includeUnstaged, message, prBody, prTitle, sessionId, t])
  const openCommentEditor = useCallback((path: string, anchor: ReviewCommentAnchor) => {
    setCommentEditor({ path, ...anchor })
    setCommentDraft('')
    setCommentError(undefined)
  }, [])
  const closeCommentEditor = useCallback(() => {
    setCommentEditor(undefined)
    setCommentDraft('')
    setCommentError(undefined)
  }, [])
  const submitComment = useCallback(async () => {
    if (commentEditor === undefined || commentDraft.trim().length === 0 || commentBusy) return
    setCommentBusy(true)
    setCommentError(undefined)
    try {
      const created = await addReviewComment(sessionId, {
        path: commentEditor.path,
        line: commentEditor.line,
        ...(commentEditor.startLine === undefined ? {} : { startLine: commentEditor.startLine }),
        side: commentEditor.side,
        text: commentDraft.trim(),
      })
      setLocalComments(list => [...list, created])
      closeCommentEditor()
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : t('reviewCommentFailed'))
    } finally {
      setCommentBusy(false)
    }
  }, [closeCommentEditor, commentBusy, commentDraft, commentEditor, sessionId, t])
  const removeComment = useCallback((id: string) => {
    setRemovedCommentIds(previous => new Set([...previous, id]))
    void removeReviewComment(sessionId, id).catch(() => {
      setRemovedCommentIds(previous => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    })
  }, [sessionId])
  // Locally added comments only bridge the polling gap: once the projection
  // reports an id, the server copy is authoritative — dropping the local copy
  // lets removals made elsewhere (e.g. the composer chips) disappear here too.
  useEffect(() => {
    const projected = new Set((projection.reviewComments ?? []).map(comment => comment.id))
    setLocalComments(list => (list.some(comment => projected.has(comment.id))
      ? list.filter(comment => !projected.has(comment.id))
      : list))
    setRemovedCommentIds(previous => {
      const kept = [...previous].filter(id => projected.has(id))
      return kept.length === previous.size ? previous : new Set(kept)
    })
  }, [projection.reviewComments])
  const reviewComments = useMemo(() => {
    const merged = new Map<string, ReviewComment>()
    for (const comment of projection.reviewComments ?? []) merged.set(comment.id, comment)
    for (const comment of localComments) merged.set(comment.id, comment)
    for (const id of removedCommentIds) merged.delete(id)
    return [...merged.values()]
  }, [localComments, projection.reviewComments, removedCommentIds])
  useEffect(() => () => actionController.current?.abort(), [])
  useEffect(() => {
    if (!projection.owned || repository?.status !== 'ready' || diff === undefined) closeDetails()
  }, [closeDetails, diff, projection.owned, repository?.status])
  if (!projection.owned || repository?.status !== 'ready' || diff === undefined) return null
  const branch = repository.detached === true ? t('repositoryDetached') : repository.branch ?? t('repositoryUnknownBranch')
  const availability = repositoryActionAvailability(repository)
  const anyActionAvailable = availability['commit'] || availability['commit-push'] || availability['push'] || availability['create-pr']
  const menuItems: readonly MenuEntry[] = [
    { id: 'commit', label: t('diffCommit'), disabled: !availability['commit'] },
    { id: 'commit-push', label: t('diffCommitPush'), disabled: !availability['commit-push'] },
    { id: 'push', label: t('diffPush'), disabled: !availability['push'] },
    { id: 'create-pr', label: t('diffCreatePr'), disabled: !availability['create-pr'] },
  ]
  const completed = dialog?.commit !== undefined && dialog.error === undefined
  const commentEditorNode: ReactNode = commentEditor === undefined ? null : (
    <div style={styles.diffCommentBlock}>
      <div style={styles.diffCommentRange}>{commentLineLabel(commentEditor, t)}</div>
      <textarea
        className={styles.diffCommentTextareaClass}
        style={styles.diffCommentTextarea}
        value={commentDraft}
        maxLength={2000}
        placeholder={t('reviewCommentPlaceholder')}
        autoFocus
        onChange={event => setCommentDraft(event.currentTarget.value)}
      />
      {commentError !== undefined ? <p style={styles.diffCommentError}>{commentError}</p> : null}
      <div style={styles.diffCommentActions}>
        <button type="button" style={styles.diffCommentActionButton} onClick={closeCommentEditor}>{t('reviewCommentCancel')}</button>
        <button type="button" style={{ ...styles.diffCommentActionButton, ...styles.diffCommentSubmitButton }} disabled={commentBusy || commentDraft.trim().length === 0} onClick={() => void submitComment()}>{t('reviewCommentSubmit')}</button>
      </div>
    </div>
  )
  return (
    <>
      <style data-dsh-claude-repository-modal-styles>{styles.detailsCardCss}{styles.diffModalCss}{styles.panelIconButtonCss}{styles.diffCommentCss}{styles.diffCommentMarkdownCss}</style>
      <div className={styles.detailsCardClass} style={{ ...styles.diffPanel, ...(maximized ? styles.diffPanelMaximized : {}) }}>
        <header style={styles.diffHeader}>
          <div style={styles.diffHeaderTitle}><span style={styles.diffHeaderBranch}>{branch}</span><span aria-hidden="true">›</span><span style={styles.diffHeaderLabel}>{t('diffWorkingTree')}</span></div>
          <div style={styles.diffHeaderActions}>
            <div style={styles.diffSplitButton}>
              <button type="button" style={{ ...styles.diffCommitButton, ...(availability['commit'] ? {} : styles.diffActionDisabled) }} disabled={!availability['commit']} onClick={() => openAction('commit')}>{t('diffCommit')}</button>
              <Menu open={menuOpen} items={menuItems} onSelect={(id: string) => { if (availability[id as RepositoryActionKind]) openAction(id as RepositoryActionKind) }} onClose={() => setMenuOpen(false)} align="end" portal anchor={
                <button type="button" style={{ ...styles.diffCommitMenuButton, ...(anyActionAvailable ? {} : styles.diffActionDisabled) }} disabled={!anyActionAvailable} aria-label={t('diffCommitMenu')} aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><IconChevronDownOutline14 /></button>
              } />
            </div>
            {ghComments.length > 0 && submitPrompt !== undefined ? (
              <button type="button" style={styles.diffPrCommentsButton} title={t('prCommentsSend')} aria-label={t('prCommentsButton', { count: ghComments.length })} onClick={() => submitPrompt(composeCommentsPrompt(ghComments))}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2.75 2.75h10.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8.2l-3.2 2.9v-2.9H2.75a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1Z" />
                </svg>
                {ghComments.length}
              </button>
            ) : null}
            <button type="button" className={styles.panelIconButtonClass} aria-label={maximized ? t('diffRestore') : t('diffMaximize')} onClick={toggleMaximized}>{maximized ? <RestorePanelIcon /> : <IconFullscreenOutline16 />}</button>
            <button type="button" className={styles.panelIconButtonClass} aria-label={t('diffClose')} onClick={closeDetails}><IconCloseOutline16 /></button>
          </div>
        </header>
        <div style={styles.diffSummary}>
          <span>{t('diffFiles', { count: diff.files })}</span>
          <span style={styles.diffAdd}>+{diff.additions}</span>
          <span style={styles.diffDelete}>−{diff.deletions}</span>
        </div>
        <div ref={diffBodyRef} style={styles.diffBody}>
          {diff.truncated ? <p style={styles.diffNotice}>{t('diffTruncated')}</p> : null}
          {files.length === 0 ? <p style={styles.diffEmpty}>{t('diffEmpty')}</p> : files.map((file, index) => (
            <DiffFileSection
              key={file.path}
              file={file}
              root={repository.root}
              initiallyOpen={index === 0}
              t={t}
              comments={reviewComments.filter(comment => comment.path === file.path)}
              ghComments={ghComments.filter(comment => comment.path === file.path)}
              editorAnchor={commentEditor !== undefined && commentEditor.path === file.path ? commentEditor : undefined}
              editorNode={commentEditorNode}
              onOpenEditor={anchor => openCommentEditor(file.path, anchor)}
              onRemoveComment={removeComment}
            />
          ))}
        </div>
      </div>
      <Modal className="dshClaudeRepositoryActionModal" contentClassName="dshClaudeRepositoryActionModalContent" open={dialog !== undefined} onClose={closeDialog} title={dialog === undefined ? t('diffCommit') : actionLabel(dialog.action, t)} closeLabel={t('diffCancel')} description={t('diffConfirmDescription')} footer={
        <div style={styles.diffModalFooter}>
          <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={closeDialog}>{completed ? t('diffDone') : t('diffCancel')}</button>
          {!completed ? <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} disabled={dialog?.loading === true || dialog?.submitting === true || dialog?.preview === undefined || (dialog.action !== 'push' && message.trim() === '')} onClick={() => void confirm()}>{dialog?.submitting === true ? t('diffSubmitting') : t('diffConfirm')}</button> : null}
        </div>
      }>
        {dialog?.loading === true ? <p style={styles.diffModalStatus}>{t('diffGeneratingMessage')}</p> : null}
        {dialog?.preview !== undefined ? <div style={styles.diffModalBody}>
          <div style={styles.diffModalMeta}><strong style={styles.diffModalMetaText} title={dialog.preview.branch}>{dialog.action === 'push'
            ? `${dialog.preview.branch} → ${dialog.preview.upstream ?? `origin/${dialog.preview.branch}`}`
            : dialog.preview.branch}</strong><span style={styles.diffModalFileState}>{dialog.action === 'push'
            ? t('diffPushAhead', { count: dialog.preview.unpushedTruncated ? `${dialog.preview.unpushedCommits.length}+` : dialog.preview.unpushedCommits.length })
            : t('diffFiles', { count: dialog.preview.files.length })}</span></div>
          {dialog.action === 'push' ? <>
            <div style={styles.diffModalFiles}>{dialog.preview.unpushedCommits.map(commit => <div key={commit.hash} style={styles.diffModalFile}><span style={styles.diffModalFilePath} title={commit.subject}>{commit.subject}</span><span style={styles.diffModalFileState}>{commit.hash.slice(0, 8)}</span></div>)}</div>
            <p style={styles.diffModalStatus}>{t('diffPushDescription')}</p>
          </> : <>
            <div style={styles.diffModalFiles}>{dialog.preview.files.map(file => <div key={file.path} style={styles.diffModalFile}><span style={styles.diffModalFilePath} title={file.path}>{file.path}</span><span style={styles.diffModalFileState}>{file.untracked ? t('diffUntracked') : file.staged && file.unstaged ? t('diffStagedUnstaged') : file.staged ? t('diffStaged') : t('diffUnstaged')}</span></div>)}</div>
            <label style={styles.diffModalCheckbox}><input type="checkbox" checked={includeUnstaged} disabled={!dialog.preview.hasUnstaged && !dialog.preview.hasUntracked} onChange={event => setIncludeUnstaged(event.currentTarget.checked)} />{t('diffIncludeUnstaged')}</label>
            <label style={styles.diffModalField}>{t('diffCommitMessage')}<textarea style={styles.diffModalTextarea} value={message} maxLength={512} onChange={event => setMessage(event.currentTarget.value)} /></label>
          </>}
          {dialog.action === 'create-pr' ? <>
            <label style={styles.diffModalField}>{t('diffPrTitle')}<input style={styles.diffModalTextInput} value={prTitle} maxLength={256} onChange={event => setPrTitle(event.currentTarget.value)} /></label>
            <label style={styles.diffModalField}>{t('diffPrBase')}<input style={styles.diffModalTextInput} value={baseBranch} maxLength={512} placeholder={t('diffPrBaseDefault')} onChange={event => setBaseBranch(event.currentTarget.value)} /></label>
            <label style={styles.diffModalField}>{t('diffPrDescription')}<textarea style={{ ...styles.diffModalTextarea, minHeight: 240 }} value={prBody} maxLength={8192} onChange={event => setPrBody(event.currentTarget.value)} /></label>
            <label style={styles.diffModalCheckbox}><input type="checkbox" checked={draft} onChange={event => setDraft(event.currentTarget.checked)} />{t('diffPrDraft')}</label>
          </> : null}
          {dialog.commit !== undefined ? <p style={styles.diffModalSuccess}>{dialog.action === 'push'
            ? t('diffPushCompleted', { commit: dialog.commit.slice(0, 8) })
            : t('diffCommitCompleted', { commit: dialog.commit.slice(0, 8) })}</p> : null}
          {dialog.pullRequestUrl !== undefined ? <a href={dialog.pullRequestUrl} target="_blank" rel="noopener noreferrer">{t('diffOpenPr')}</a> : null}
        </div> : null}
        {dialog?.error !== undefined ? <p role="alert" style={styles.diffModalError}>{dialog.error}{dialog.commit === undefined ? '' : ` ${t('diffCommitPreserved', { commit: dialog.commit.slice(0, 8) })}`}</p> : null}
      </Modal>
    </>
  )
}
