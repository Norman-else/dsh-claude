import { useState } from 'react'
import { HoverCard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewComment } from '../review-comments.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import { clearReviewComments, removeReviewComment } from './review-comment-api.ts'
import * as styles from './styles.ts'

export interface ClaudeReviewCommentsInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  sessionId: string
  /** Submit the composer, seeding the given draft text when it is empty. */
  submitWith?: (fallbackDraft: string) => void
}

export interface ClaudeReviewCommentsProps extends ClaudeReviewCommentsInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

export function reviewCommentChipLabel(comment: Pick<ReviewComment, 'path' | 'line' | 'startLine'>): string {
  const name = comment.path.split('/').at(-1) ?? comment.path
  return `${name}:${comment.startLine === undefined ? comment.line : `${comment.startLine}-${comment.line}`}`
}

/** "Line 12" / "Lines 10–12", with the old-side variant when the comment sits on removed code. */
export function commentLineLabel(
  comment: Pick<ReviewComment, 'line' | 'side' | 'startLine'>,
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string,
): string {
  if (comment.startLine !== undefined) {
    return t(comment.side === 'old' ? 'reviewCommentOldRange' : 'reviewCommentNewRange', { start: comment.startLine, end: comment.line })
  }
  return t(comment.side === 'old' ? 'reviewCommentOldSide' : 'reviewCommentNewSide', { line: comment.line })
}

function CommentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.75 2.75h10.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8.2l-3.2 2.9v-2.9H2.75a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1Z" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2 7.3 8.7M14 2 9.7 14l-2.4-5.3L2 6.3 14 2Z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4h11M6.3 2.5h3.4M4.2 4l.65 9.3a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93L11.8 4M6.7 6.8v4.6M9.3 6.8v4.6" />
    </svg>
  )
}

function CommentChip({ comment, t, onRemove }: {
  comment: ReviewComment
  t: ClaudeReviewCommentsInjected['t']
  onRemove: (id: string) => void
}) {
  return (
    <HoverCard
      anchor={
        <span style={styles.reviewCommentChip}>
          <span style={styles.reviewCommentChipLabel}>{reviewCommentChipLabel(comment)}</span>
          <button type="button" style={styles.reviewCommentChipRemove} aria-label={t('reviewCommentRemove')} onClick={() => onRemove(comment.id)}>×</button>
        </span>
      }
      content={
        <span style={styles.reviewCommentHoverCard}>
          <span style={styles.reviewCommentHoverPath}>{comment.path} · {commentLineLabel(comment, t)}</span>
          <p style={styles.reviewCommentHoverText}>{comment.text}</p>
        </span>
      }
      openDelayMs={250}
      // Required since primitives 0.1.2; this card passes no copyText, so the
      // copy affordance they name never appears.
      copyLabel={t('markdownCopy')}
      copiedLabel={t('markdownCopied')}
    />
  )
}

/** Pending review comments docked above the composer; drained by the next user turn. */
export function ClaudeReviewComments({ useClaudeProjection, t, sessionId, submitWith }: ClaudeReviewCommentsProps) {
  const projection = useClaudeProjection(value => value)
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set())
  const comments = (projection.reviewComments ?? []).filter(comment => !removedIds.has(comment.id))
  if (!projection.owned || comments.length === 0) return null
  const remove = (id: string): void => {
    setRemovedIds(previous => new Set([...previous, id]))
    void removeReviewComment(sessionId, id).catch(() => {
      setRemovedIds(previous => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    })
  }
  const clearAll = (): void => {
    const ids = comments.map(comment => comment.id)
    setRemovedIds(previous => new Set([...previous, ...ids]))
    void clearReviewComments(sessionId).catch(() => {
      setRemovedIds(previous => {
        const next = new Set(previous)
        for (const id of ids) next.delete(id)
        return next
      })
    })
  }
  return (
    <div style={styles.reviewCommentBarFrame}>
      <style data-dsh-claude-review-comment-styles>{styles.panelIconButtonCss}</style>
      <div style={styles.reviewCommentBar}>
        <span style={styles.reviewCommentIcon}><CommentIcon /></span>
        {comments.map(comment => <CommentChip key={comment.id} comment={comment} t={t} onRemove={remove} />)}
        <span style={styles.reviewCommentClearSeat}>
          {submitWith === undefined ? null : (
            <button type="button" className={styles.panelIconButtonClass} aria-label={t('reviewCommentsSend')} onClick={() => submitWith(t('reviewCommentsSendDraft'))}><SendIcon /></button>
          )}
          <button type="button" className={styles.panelIconButtonClass} aria-label={t('reviewCommentsClear')} onClick={clearAll}><TrashIcon /></button>
        </span>
      </div>
    </div>
  )
}
