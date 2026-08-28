import { useState } from 'react'
import { IconRightUpOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MentionableUser, PullRequestReviewComment, PullRequestReviewThread } from './pr-feedback-api.ts'
import { renderCommentBody } from './comment-markdown.ts'
import { relativeAge } from './relative-age.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { MentionTextarea } from './MentionTextarea.tsx'
import * as styles from './styles.ts'

const BOT_SUFFIX = '[bot]'

/** GitHub prints an app account as its name plus a Bot pill rather than as the
 *  raw `name[bot]` login. GraphQL already drops that suffix, so the flag from
 *  the API decides and the suffix is only stripped for display. */
function identity(author: string): string {
  return author.endsWith(BOT_SUFFIX) ? author.slice(0, -BOT_SUFFIX.length) : author
}

function CommentBody({ comment, t, now, first }: {
  comment: PullRequestReviewComment
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  now: number | undefined
  first: boolean
}) {
  const name = identity(comment.author)
  const age = relativeAge(comment.createdAt, now)
  return (
    <div style={{ ...styles.diffGhComment, ...(first ? {} : styles.diffGhCommentNext) }}>
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
          <span style={styles.diffGhCommentAuthor}>@{name}</span>
          {comment.bot !== true ? null : <span style={styles.diffThreadBadge}>{t('reviewThreadBot')}</span>}
          {age === undefined ? null : <span style={styles.diffGhCommentAge}>{t('reviewThreadAgo', { age })}</span>}
        </span>
        <Tooltip label={t('reviewThreadOpenOnGitHub')} side="bottom" delayMs={250}>
          <a
            href={comment.url}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.diffGhCommentLink}
            aria-label={t('reviewThreadOpenOnGitHub')}
          >
            <IconRightUpOutline14 />
          </a>
        </Tooltip>
      </div>
      <div
        style={styles.diffCommentCardText}
        className="dshClaudeDiffCommentBody"
        // Sanitized against this plugin's own allowlist; see comment-markdown.ts.
        dangerouslySetInnerHTML={{ __html: renderCommentBody(comment.body) }}
      />
    </div>
  )
}

/** One GitHub review conversation, anchored on its diff line: every comment in
 *  the thread, plus the two things a reviewer expects to do with it — answer it
 *  and close it. A resolved thread collapses, because the diff is about what
 *  still needs attention. */
export function ReviewThreadCard({ thread, t, now, anchorKey, active = false, suggest, onReply, onResolvedChange }: {
  thread: PullRequestReviewThread
  /** Anchor the panel's prev/next walk scrolls to. */
  anchorKey?: string
  active?: boolean
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Fixed clock for the comment ages; defaults to the wall clock. */
  now?: number
  suggest: (query: string) => Promise<readonly MentionableUser[]>
  onReply: (body: string) => Promise<void>
  onResolvedChange: (resolved: boolean) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const first = thread.comments[0]
  if (first === undefined) return null
  const collapsed = thread.resolved && !expanded

  const send = (): void => {
    const body = draft.trim()
    if (body.length === 0 || busy) return
    setBusy(true)
    setError(undefined)
    void onReply(body).then(() => {
      setDraft('')
      setReplying(false)
    }, (reason: unknown) => {
      // The draft survives a failure; retyping a review reply is a real loss.
      setError(reason instanceof Error ? reason.message : t('reviewThreadReplyFailed'))
    }).finally(() => { setBusy(false) })
  }

  const toggleResolved = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void onResolvedChange(!thread.resolved).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t('reviewThreadResolveFailed'))
    }).finally(() => { setBusy(false) })
  }

  const frame = {
    ...(anchorKey === undefined ? {} : { 'data-review-target': anchorKey }),
    ...(active ? { 'data-review-active': 'true' } : {}),
    style: { ...styles.diffCommentBlock, ...(active ? styles.diffCommentBlockActive : {}) },
  }

  if (collapsed) {
    return (
      <div {...frame}>
        <button
          type="button"
          aria-expanded={false}
          style={styles.diffThreadSummary}
          onClick={() => { setExpanded(true) }}
        >
          <span style={styles.diffThreadBadge}>{t('reviewThreadResolved')}</span>
          <span style={styles.diffGhCommentAuthor}>@{identity(first.author)}</span>
          <span style={styles.diffThreadExcerpt}>{first.body.split('\n')[0]}</span>
        </button>
      </div>
    )
  }

  return (
    <div {...frame}>
      {!thread.resolved && !thread.outdated ? null : (
        <div style={styles.diffThreadBadges}>
          {thread.resolved ? <span style={styles.diffThreadBadge}>{t('reviewThreadResolved')}</span> : null}
          {thread.outdated ? <span style={styles.diffThreadBadge}>{t('reviewThreadOutdated')}</span> : null}
        </div>
      )}
      {/* One bot often answers itself, so each comment carries its own author
          row and age — the way GitHub tells a reply from the comment above it. */}
      {thread.comments.map((comment, index) => (
        <CommentBody key={comment.id} comment={comment} t={t} now={now} first={index === 0} />
      ))}
      {error === undefined ? null : <p style={styles.diffCommentError}>{error}</p>}
      {replying ? (
        <div data-review-reply="" style={styles.diffThreadComposer}>
          {/* The box answers the comment above it, so it says whose comment. */}
          <span style={styles.diffThreadComposerCaption}>{t('reviewThreadReplyTo', { author: identity(thread.comments[thread.comments.length - 1]?.author ?? first.author) })}</span>
          <MentionTextarea
            value={draft}
            placeholder={t('reviewThreadReplyPlaceholder')}
            suggestLabel={t('reviewThreadMention')}
            disabled={busy}
            autoFocus
            suggest={suggest}
            onChange={setDraft}
            onSubmit={send}
          />
          <div style={styles.diffCommentActions}>
            <button
              type="button"
              style={styles.diffCommentActionButton}
              disabled={busy}
              onClick={() => { setReplying(false); setError(undefined) }}
            >
              {t('reviewCommentCancel')}
            </button>
            <button
              type="button"
              style={{ ...styles.diffCommentActionButton, ...styles.diffCommentSubmitButton }}
              disabled={busy || draft.trim().length === 0}
              onClick={send}
            >
              {t('reviewThreadSend')}
            </button>
          </div>
        </div>
      ) : (
        <div style={styles.diffCommentActions}>
          <button type="button" style={styles.diffCommentActionButton} disabled={busy} onClick={() => { setReplying(true) }}>
            {t('reviewThreadReply')}
          </button>
          <button type="button" style={styles.diffCommentActionButton} disabled={busy} onClick={toggleResolved}>
            {thread.resolved ? t('reviewThreadUnresolve') : t('reviewThreadResolve')}
          </button>
        </div>
      )}
    </div>
  )
}
