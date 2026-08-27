import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, Menu, Modal, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepositoryMergeMethod } from '../repository-actions.ts'
import type { RepositoryStatus } from '../repository-status.ts'
import { executeRepositoryAction, loadRepositoryActionPreview } from './repository-action-api.ts'
import { cleanupMergedRepository } from './repository-setup-api.ts'
import { composeChecksPrompt, composeConflictsPrompt, loadFailingChecks, loadPullRequestComments, type FailingCheck, type PullRequestReviewComment } from './pr-feedback-api.ts'
import { AUTO_FIX_INTERVAL_MS, autoFixEnabled, autoFixMemory, planAutoFix, rememberAutoFix, setAutoFixEnabled } from './auto-fix.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'

export interface ClaudeRepositoryStatusInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  openDiff: () => void
  /** Submit the composer, seeding the given draft text when it is empty. */
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
  /** Open the cross-session pull request overview panel. */
  openOverview?: () => void
  /** Delete the DSH workspace owning this session (after its worktree is gone). */
  deleteWorkspace?: () => Promise<void>
}

export interface ClaudeRepositoryStatusProps extends ClaudeRepositoryStatusInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  useSessions: SnapshotSelectorHook<{ readonly byId: Readonly<Record<string, { readonly blank: boolean; readonly running?: boolean } | undefined>> }>
  sessionId: string
}

export function repositorySummary(repository: RepositoryStatus, t: ClaudeRepositoryStatusInjected['t']): readonly string[] {
  if (repository.status === 'not-repository') return [t('repositoryNotGit')]
  if (repository.status === 'unavailable') return [t('repositoryUnavailable')]
  const pullRequest = repository.pullRequest
  return [
    repository.detached === true ? t('repositoryDetached') : repository.branch ?? t('repositoryUnknownBranch'),
    ...(repository.worktree === true ? [t('repositoryWorktree')] : []),
    repository.dirty === true ? t('repositoryModified') : t('repositoryClean'),
    ...(pullRequest === undefined
      ? [t('repositoryNoPr')]
      : pullRequest.state === 'merged'
        ? [
            t('repositoryPr', { number: pullRequest.number }),
            t('repositoryState_merged'),
          ]
        : [
            pullRequest.draft ? t('repositoryPrDraft', { number: pullRequest.number }) : t('repositoryPr', { number: pullRequest.number }),
            t(`repositoryChecks_${pullRequest.checks}` as ClaudeCodeSettingsKey),
            t(`repositoryReview_${pullRequest.review}` as ClaudeCodeSettingsKey),
          ]),
  ]
}

/** Icon-only status: the tone carries the state, the full label lives in the tooltip and accessible name. */
function StatusGlyph({ label, tone, children }: { label: string; tone: 'neutral' | 'success' | 'warning' | 'error'; children: ReactNode }) {
  const toneStyle = tone === 'success'
    ? styles.repositoryItemSuccess
    : tone === 'warning' ? styles.repositoryItemWarning : tone === 'error' ? styles.repositoryItemError : {}
  return (
    <Tooltip label={label} side="top" delayMs={250}>
      <span role="img" aria-label={label} style={{ ...styles.repositoryGlyph, ...toneStyle }}>{children}</span>
    </Tooltip>
  )
}

function ChecksGlyph({ state }: { state: 'passing' | 'pending' | 'failing' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" />
      {state === 'passing' ? <path d="M4.5 7.2l1.8 1.8 3.2-3.6" />
        : state === 'failing' ? <path d="M5 5l4 4M9 5l-4 4" />
        : <path d="M4.6 7h.01M7 7h.01M9.4 7h.01" strokeWidth="2" />}
    </svg>
  )
}

function ReviewGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 7s2-3.5 5.5-3.5S12.5 7 12.5 7s-2 3.5-5.5 3.5S1.5 7 1.5 7Z" />
      <circle cx="7" cy="7" r="1.8" />
    </svg>
  )
}

function PullRequestIcon({ size = 16, merged = false }: { size?: number; merged?: boolean }) {
  if (merged) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="4" cy="3" r="1.6" />
        <circle cx="4" cy="13" r="1.6" />
        <circle cx="12" cy="8" r="1.6" />
        <path d="M4 4.6v6.8" />
        <path d="M5.6 3H7a5 5 0 0 1 5 3.4" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="3" r="1.6" />
      <circle cx="4" cy="13" r="1.6" />
      <circle cx="12" cy="13" r="1.6" />
      <path d="M4 4.6v6.8" />
      <path d="M7.5 3H9a3 3 0 0 1 3 3v5.4" />
    </svg>
  )
}

function repositoryName(remote: string | undefined): string | undefined {
  return remote?.split('/').at(-1)
}

function relativeAge(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const elapsedHours = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 3_600_000))
  if (!Number.isFinite(elapsedHours)) return undefined
  if (elapsedHours < 1) return '<1h'
  if (elapsedHours < 24) return `${elapsedHours}h`
  const days = Math.floor(elapsedHours / 24)
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`
}

export function PullRequestHoverCard({ repository, t }: { repository: RepositoryStatus; t: ClaudeRepositoryStatusInjected['t'] }) {
  const pullRequest = repository.pullRequest
  if (pullRequest === undefined) return null
  const merged = pullRequest.state === 'merged'
  const age = relativeAge(merged ? pullRequest.mergedAt : pullRequest.createdAt)
  return (
    <span role="tooltip" style={styles.repositoryPrHoverCard}>
      <span style={styles.repositoryPrHoverTop}>
        <span style={{ ...styles.repositoryPrStateBadge, ...(merged ? styles.repositoryPrStateBadgeMerged : {}) }}><PullRequestIcon size={13} merged={merged} />{t(`repositoryState_${pullRequest.state}` as ClaudeCodeSettingsKey)}</span>
        <span style={styles.repositoryPrHoverRepo}>{repositoryName(repository.remote)} #{pullRequest.number}{pullRequest.baseBranch === undefined ? '' : ` → ${pullRequest.baseBranch}`}</span>
        {age === undefined ? null : <span style={styles.repositoryPrHoverAge}>{age}</span>}
      </span>
      <a href={pullRequest.url} target="_blank" rel="noopener noreferrer" style={styles.repositoryPrHoverTitle}>{pullRequest.title}</a>
      <span style={styles.repositoryPrHoverBottom}>
        {pullRequest.author === undefined ? <span /> : <span style={styles.repositoryPrAuthor}><span style={styles.repositoryPrAvatar}>{pullRequest.author.slice(0, 1).toUpperCase()}</span>{pullRequest.author}</span>}
        <span style={styles.repositoryPrHoverStats}>
          <span><span style={styles.diffAdd}>+{repository.diff?.additions ?? 0}</span> <span style={styles.diffDelete}>−{repository.diff?.deletions ?? 0}</span></span>
          <span style={styles.repositoryPrFiles}>{t('diffFilesShort', { count: repository.diff?.files ?? 0 })}</span>
        </span>
      </span>
    </span>
  )
}

function PullRequestLink({ repository, t }: { repository: RepositoryStatus; t: ClaudeRepositoryStatusInjected['t'] }) {
  const [hovered, setHovered] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const pullRequest = repository.pullRequest
  const open = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = undefined
    setHovered(true)
  }
  const scheduleClose = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setHovered(false)
    }, 350)
  }
  useEffect(() => () => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
  }, [])
  if (pullRequest === undefined) return null
  return (
    <span
      style={styles.repositoryPrLinkFrame}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
      onFocus={open}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose()
      }}
    >
      {hovered ? <span onMouseEnter={open} onMouseLeave={scheduleClose}><PullRequestHoverCard repository={repository} t={t} /></span> : null}
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ ...styles.repositoryPrLink, ...(pullRequest.state === 'merged' ? styles.repositoryPrLinkMerged : {}) }}
        aria-label={t('repositoryOpenPr', { number: pullRequest.number })}
      >#{pullRequest.number}</a>
    </span>
  )
}

/** Watches an open pull request and hands new review comments and failing
 *  CI runs to Claude automatically until the user switches it off. */
export function AutoFixControl({ sessionId, repository, running, t, submitPrompt }: {
  sessionId: string
  repository: RepositoryStatus
  /** Whether a turn is in flight; the watcher only submits into an idle session. */
  running: boolean
  t: ClaudeRepositoryStatusInjected['t']
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}) {
  const pullRequest = repository.pullRequest
  const open = pullRequest?.state === 'open'
  const number = pullRequest?.number
  const checks = pullRequest?.checks
  const [enabled, setEnabled] = useState(() => autoFixEnabled(sessionId))
  const [focused, setFocused] = useState(false)
  useEffect(() => { setEnabled(autoFixEnabled(sessionId)) }, [sessionId])
  // Submitting while a turn runs would queue or steer (interrupt) it depending
  // on the user's Enter-while-busy setting, so wait for idle instead; the
  // running flip re-arms the effect and polls immediately when the turn ends.
  useEffect(() => {
    if (!enabled || !open || running || number === undefined || submitPrompt === undefined) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const [comments, failing] = await Promise.all([
        loadPullRequestComments(sessionId, number).catch((): readonly PullRequestReviewComment[] => []),
        checks === 'failing' ? loadFailingChecks(sessionId, number).catch((): readonly FailingCheck[] => []) : Promise.resolve<readonly FailingCheck[]>([]),
      ])
      if (cancelled) return
      const plan = planAutoFix(autoFixMemory(sessionId), comments, failing)
      // A non-empty user draft defers this round instead of clobbering it.
      if (plan.prompt !== undefined && submitPrompt(plan.prompt, 'idle')) rememberAutoFix(sessionId, plan.memory)
    }
    void tick()
    const timer = setInterval(() => { void tick() }, AUTO_FIX_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [checks, enabled, number, open, running, sessionId, submitPrompt])
  if (!open || submitPrompt === undefined) return null
  const toggle = (): void => {
    const next = !enabled
    setEnabled(next)
    setAutoFixEnabled(sessionId, next)
  }
  return (
    <Tooltip label={`${t('autoFixLabel')} · ${t('autoFixTitle')}`} side="top" delayMs={250} maxWidth={320}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t('autoFixLabel')}
        style={{
          ...styles.repositoryAutoFix,
          ...(enabled ? styles.repositoryAutoFixActive : {}),
          ...(focused ? styles.heroWorktreeToggleFocused : {}),
        }}
        onFocus={() => { setFocused(true) }}
        onBlur={() => { setFocused(false) }}
        onClick={event => {
          toggle()
          // Mouse toggles should not leave a focus ring behind.
          event.currentTarget.blur()
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.3 6.5A5.5 5.5 0 0 0 3.6 4.6M2.7 9.5a5.5 5.5 0 0 0 9.7 1.9" />
          <path d="M13.5 2.8v3.7H9.8M2.5 13.2V9.5h3.7" />
        </svg>
      </button>
    </Tooltip>
  )
}

export function FailingChecksControl({ sessionId, pullNumber, t, submitPrompt }: {
  sessionId: string
  pullNumber: number
  t: ClaudeRepositoryStatusInjected['t']
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [checks, setChecks] = useState<readonly FailingCheck[]>([])
  const [error, setError] = useState<string>()
  const frameRef = useRef<HTMLSpanElement>(null)
  const controller = useRef<AbortController>()
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && frameRef.current?.contains(event.target) !== true) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => { document.removeEventListener('pointerdown', closeOnOutsidePointer) }
  }, [open])
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next) return
    controller.current?.abort()
    const aborter = new AbortController()
    controller.current = aborter
    setLoading(true)
    setError(undefined)
    void loadFailingChecks(sessionId, pullNumber, aborter.signal).then(value => {
      setChecks(value)
      setLoading(false)
    }, (reason: unknown) => {
      if (aborter.signal.aborted) return
      setError(reason instanceof Error ? reason.message : t('diffActionFailed'))
      setLoading(false)
    })
  }
  return (
    <span ref={frameRef} style={styles.repositoryChecksFrame}>
      <button type="button" style={styles.repositoryChecksTrigger} aria-haspopup="dialog" aria-expanded={open} aria-label={t('repositoryChecksOpen')} onClick={toggle}>
        <StatusGlyph label={t('repositoryChecks_failing')} tone="error"><ChecksGlyph state="failing" /></StatusGlyph>
      </button>
      {open ? (
        <span role="dialog" aria-label={t('checksCardTitle')} style={styles.repositoryChecksCard}>
          <strong style={styles.repositoryChecksTitle}>{t('checksCardTitle')}</strong>
          {loading ? <span style={styles.repositoryChecksHint}>{t('checksCardLoading')}</span> : null}
          {error === undefined ? null : <span role="alert" style={styles.repositoryChecksError}>{error}</span>}
          {checks.map(check => (
            <span key={check.name} style={styles.repositoryChecksItem}>
              {check.link === undefined
                ? <span style={styles.repositoryChecksName}>{check.name}</span>
                : <a href={check.link} target="_blank" rel="noopener noreferrer" style={styles.repositoryChecksName}>{check.name}</a>}
              {check.description === undefined ? null : <span style={styles.repositoryChecksDesc}>{check.description}</span>}
            </span>
          ))}
          {!loading && error === undefined && checks.length === 0 ? <span style={styles.repositoryChecksHint}>{t('checksCardEmpty')}</span> : null}
          {submitPrompt !== undefined && checks.length > 0 ? (
            <button type="button" style={styles.repositoryChecksFix} onClick={() => { submitPrompt(composeChecksPrompt(checks)); setOpen(false) }}>{t('checksCardFix')}</button>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

interface UpdateDialogState {
  readonly loading: boolean
  readonly submitting: boolean
  readonly fingerprint?: string
  readonly error?: string
  readonly pushed?: string
  readonly conflicts?: readonly string[]
}

export function UpdateBranchControl({ sessionId, repository, t, submitPrompt }: {
  sessionId: string
  repository: RepositoryStatus
  t: ClaudeRepositoryStatusInjected['t']
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}) {
  const [dialog, setDialog] = useState<UpdateDialogState>()
  const controller = useRef<AbortController>()
  const pullRequest = repository.pullRequest
  const base = pullRequest?.baseBranch
  const behind = repository.baseBehind ?? 0
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (dialog?.pushed === undefined || dialog.error !== undefined) return
    const timer = setTimeout(() => setDialog(undefined), 1_200)
    return () => clearTimeout(timer)
  }, [dialog?.error, dialog?.pushed])
  if (pullRequest === undefined || pullRequest.state !== 'open' || base === undefined
    || repository.detached === true || repository.dirty === true || behind <= 0) return null
  const openDialog = (): void => {
    controller.current?.abort()
    setDialog({ loading: true, submitting: false })
    const aborter = new AbortController()
    controller.current = aborter
    void loadRepositoryActionPreview(sessionId, aborter.signal).then(preview => {
      setDialog({ loading: false, submitting: false, fingerprint: preview.fingerprint })
    }, (reason: unknown) => {
      if (!aborter.signal.aborted) setDialog({ loading: false, submitting: false, error: reason instanceof Error ? reason.message : t('diffActionFailed') })
    })
  }
  const closeDialog = (): void => {
    if (dialog?.submitting === true) return
    controller.current?.abort()
    controller.current = undefined
    setDialog(undefined)
  }
  const confirmUpdate = (): void => {
    if (dialog?.fingerprint === undefined || dialog.submitting) return
    const { error: _error, ...pending } = dialog
    setDialog({ ...pending, submitting: true })
    void executeRepositoryAction(sessionId, {
      action: 'update-branch',
      fingerprint: dialog.fingerprint,
      message: '',
      includeUnstaged: false,
      baseBranch: base,
    }).then(result => {
      setDialog({
        ...pending,
        submitting: false,
        ...(result.conflicts !== undefined && result.conflicts.length > 0 ? { conflicts: result.conflicts } : { pushed: result.commit }),
      })
    }, (reason: unknown) => {
      setDialog({ ...pending, submitting: false, error: reason instanceof Error ? reason.message : t('diffActionFailed') })
    })
  }
  const settled = dialog?.pushed !== undefined || dialog?.conflicts !== undefined
  return (
    <>
      <button type="button" style={styles.repositoryUpdateTrigger} aria-label={t('repositoryUpdateBranch')} title={`${t('diffUpdateBranchBehind', { base, count: behind })} · ${t('repositoryUpdateBranch')}`} onClick={openDialog}>↓{behind}</button>
      {dialog === undefined ? null : <style data-dsh-claude-repository-modal-styles>{styles.diffModalCss}</style>}
      <Modal className="dshClaudeRepositoryActionModal" contentClassName="dshClaudeRepositoryActionModalContent" open={dialog !== undefined} onClose={closeDialog} title={t('repositoryUpdateBranch')} closeLabel={t('diffCancel')} description={t('diffUpdateBranchDescription', { base })} footer={
        <div style={styles.diffModalFooter}>
          <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={closeDialog}>{settled ? t('diffDone') : t('diffCancel')}</button>
          {!settled ? <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} disabled={dialog?.loading === true || dialog?.submitting === true || dialog?.fingerprint === undefined} onClick={confirmUpdate}>{dialog?.submitting === true ? t('diffSubmitting') : t('diffConfirm')}</button> : null}
        </div>
      }>
        {dialog === undefined ? null : <div style={styles.diffModalBody}>
          <div style={styles.diffModalMeta}>
            <strong style={styles.diffModalMetaText} title={pullRequest.title}>{repository.branch ?? t('repositoryUnknownBranch')} ← origin/{base}</strong>
            <span style={styles.diffModalFileState}>{t('diffUpdateBranchBehind', { base, count: behind })}</span>
          </div>
          {dialog.pushed === undefined ? null : <p style={styles.diffModalSuccess}>{t('diffUpdateBranchCompleted', { commit: dialog.pushed.slice(0, 8) })}</p>}
          {dialog.conflicts === undefined ? null : <>
            <p style={styles.diffModalStatus}>{t('diffUpdateBranchConflicts')}</p>
            <ul style={styles.diffModalConflicts}>{dialog.conflicts.map(file => <li key={file}>{file}</li>)}</ul>
            {submitPrompt === undefined ? null : (
              <button type="button" style={styles.diffModalConflictResolve} onClick={() => { submitPrompt(composeConflictsPrompt(base, dialog.conflicts ?? [])); closeDialog() }}>{t('diffUpdateBranchResolve')}</button>
            )}
          </>}
          {dialog.error === undefined ? null : <p role="alert" style={styles.diffModalError}>{dialog.error}</p>}
        </div>}
      </Modal>
    </>
  )
}

interface CleanupDialogState {
  readonly submitting: boolean
  readonly done?: string
  readonly error?: string
}

/** After a merge: remove the worktree (or switch a plain checkout back to
 *  base), delete the merged branch, and drop the DSH workspace. */
export function CleanupControl({ repository, t, deleteWorkspace }: {
  repository: RepositoryStatus
  t: ClaudeRepositoryStatusInjected['t']
  deleteWorkspace?: () => Promise<void>
}) {
  const [dialog, setDialog] = useState<CleanupDialogState>()
  const pullRequest = repository.pullRequest
  const base = pullRequest?.baseBranch
  useEffect(() => {
    if (dialog?.done === undefined) return
    const timer = setTimeout(() => setDialog(undefined), 1_500)
    return () => clearTimeout(timer)
  }, [dialog?.done])
  if (pullRequest?.state !== 'merged' || base === undefined || repository.root === undefined || repository.detached === true) return null
  const root = repository.root
  const closeDialog = (): void => { if (dialog?.submitting !== true) setDialog(undefined) }
  const confirm = (): void => {
    setDialog({ submitting: true })
    void cleanupMergedRepository(root, base).then(async result => {
      if (result.mode === 'worktree' && deleteWorkspace !== undefined) await deleteWorkspace()
      setDialog({ submitting: false, done: result.branch })
    }, (reason: unknown) => {
      setDialog({ submitting: false, error: reason instanceof Error ? reason.message : t('diffActionFailed') })
    })
  }
  return (
    <>
      <button type="button" style={styles.repositoryUpdateTrigger} title={t('cleanupTitle')} onClick={() => { setDialog({ submitting: false }) }}>{t('cleanupButton')}</button>
      {dialog === undefined ? null : <style data-dsh-claude-repository-modal-styles>{styles.diffModalCss}</style>}
      <Modal className="dshClaudeRepositoryActionModal" contentClassName="dshClaudeRepositoryActionModalContent" open={dialog !== undefined} onClose={closeDialog} title={t('cleanupTitle')} closeLabel={t('diffCancel')} description={t('cleanupDescription')} footer={
        <div style={styles.diffModalFooter}>
          <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={closeDialog}>{dialog?.done === undefined ? t('diffCancel') : t('diffDone')}</button>
          {dialog?.done === undefined ? <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={confirm}>{dialog?.submitting === true ? t('diffSubmitting') : t('diffConfirm')}</button> : null}
        </div>
      }>
        {dialog === undefined ? null : <div style={styles.diffModalBody}>
          <div style={styles.diffModalMeta}>
            <strong style={styles.diffModalMetaText}>{repository.branch ?? t('repositoryUnknownBranch')} → {base}</strong>
            <span style={styles.diffModalFileState}>{repository.worktree === true ? t('repositoryWorktree') : t('repositoryLocal')}</span>
          </div>
          {dialog.done === undefined ? null : <p style={styles.diffModalSuccess}>{t('cleanupCompleted', { branch: dialog.done })}</p>}
          {dialog.error === undefined ? null : <p role="alert" style={styles.diffModalError}>{dialog.error}</p>}
        </div>}
      </Modal>
    </>
  )
}

export const MERGE_METHODS: readonly RepositoryMergeMethod[] = ['merge', 'squash', 'rebase']

interface MergeDialogState {
  readonly method: RepositoryMergeMethod
  readonly loading: boolean
  readonly submitting: boolean
  readonly fingerprint?: string
  readonly error?: string
  readonly merged?: boolean
}

export function MergePullRequestControl({ sessionId, repository, t }: {
  sessionId: string
  repository: RepositoryStatus
  t: ClaudeRepositoryStatusInjected['t']
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<MergeDialogState>()
  const controller = useRef<AbortController>()
  const pullRequest = repository.pullRequest
  useEffect(() => () => controller.current?.abort(), [])
  // Successful merges dismiss themselves once the confirmation has been seen;
  // the status bar flips to its merged state on the next projection refresh.
  useEffect(() => {
    if (dialog?.merged !== true || dialog.error !== undefined) return
    const timer = setTimeout(() => setDialog(undefined), 1_200)
    return () => clearTimeout(timer)
  }, [dialog?.error, dialog?.merged])
  if (pullRequest === undefined || pullRequest.state !== 'open' || pullRequest.draft || repository.detached === true) return null
  const openMerge = (method: RepositoryMergeMethod): void => {
    controller.current?.abort()
    setMenuOpen(false)
    setDialog({ method, loading: true, submitting: false })
    const aborter = new AbortController()
    controller.current = aborter
    void loadRepositoryActionPreview(sessionId, aborter.signal).then(preview => {
      setDialog({ method, loading: false, submitting: false, fingerprint: preview.fingerprint })
    }, (error: unknown) => {
      if (!aborter.signal.aborted) setDialog({ method, loading: false, submitting: false, error: error instanceof Error ? error.message : t('diffActionFailed') })
    })
  }
  const closeDialog = (): void => {
    if (dialog?.submitting === true) return
    controller.current?.abort()
    controller.current = undefined
    setDialog(undefined)
  }
  const confirmMerge = (): void => {
    if (dialog?.fingerprint === undefined || dialog.submitting) return
    const { error: _error, ...pending } = dialog
    setDialog({ ...pending, submitting: true })
    void executeRepositoryAction(sessionId, {
      action: 'merge-pr',
      fingerprint: dialog.fingerprint,
      message: '',
      includeUnstaged: false,
      mergeMethod: dialog.method,
    }).then(() => {
      setDialog({ ...pending, submitting: false, merged: true })
    }, (error: unknown) => {
      setDialog({ ...pending, submitting: false, error: error instanceof Error ? error.message : t('diffActionFailed') })
    })
  }
  const items: readonly MenuEntry[] = MERGE_METHODS.map(method => ({ id: method, label: t(`diffMerge_${method}` as ClaudeCodeSettingsKey) }))
  const merged = dialog?.merged === true
  return (
    <>
      <Menu open={menuOpen} items={items} onSelect={(id: string) => openMerge(id as RepositoryMergeMethod)} onClose={() => setMenuOpen(false)} align="end" portal anchor={
        <button type="button" style={styles.repositoryMergeTrigger} aria-label={t('repositoryMergeMenu')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}>{t('diffMergePr')}<IconChevronDownOutline14 /></button>
      } />
      {dialog === undefined ? null : <style data-dsh-claude-repository-modal-styles>{styles.diffModalCss}</style>}
      <Modal className="dshClaudeRepositoryActionModal" contentClassName="dshClaudeRepositoryActionModalContent" open={dialog !== undefined} onClose={closeDialog} title={t('diffMergePr')} closeLabel={t('diffCancel')} description={t('diffMergeDescription')} footer={
        <div style={styles.diffModalFooter}>
          <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={closeDialog}>{merged ? t('diffDone') : t('diffCancel')}</button>
          {!merged ? <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} disabled={dialog?.loading === true || dialog?.submitting === true || dialog?.fingerprint === undefined} onClick={confirmMerge}>{dialog?.submitting === true ? t('diffSubmitting') : t('diffConfirm')}</button> : null}
        </div>
      }>
        {dialog === undefined ? null : <div style={styles.diffModalBody}>
          <div style={styles.diffModalMeta}>
            <strong style={styles.diffModalMetaText} title={pullRequest.title}>{t('repositoryPr', { number: pullRequest.number })} → {pullRequest.baseBranch ?? t('diffPrBaseDefault')}</strong>
            <span style={styles.diffModalFileState}>{t(`diffMerge_${dialog.method}` as ClaudeCodeSettingsKey)}</span>
          </div>
          <p style={styles.diffModalStatus}>{pullRequest.title}</p>
          {merged ? <p style={styles.diffModalSuccess}>{t('diffMergeCompleted', { number: pullRequest.number })}</p> : null}
          {dialog.error === undefined ? null : <p role="alert" style={styles.diffModalError}>{dialog.error}</p>}
        </div>}
      </Modal>
    </>
  )
}

export function ClaudeRepositoryStatus({ sessionId, useSessions, useClaudeProjection, t, openDiff, submitPrompt, openOverview, deleteWorkspace }: ClaudeRepositoryStatusProps) {
  const blank = useSessions(value => value.byId[sessionId]?.blank === true)
  const running = useSessions(value => value.byId[sessionId]?.running === true)
  const projection = useClaudeProjection(value => value)
  const repository = projection.repository
  if (blank || !projection.owned || repository === undefined) return null
  const branch = repository.detached === true ? t('repositoryDetached') : repository.branch ?? t('repositoryUnknownBranch')
  const pullRequest = repository.pullRequest
  const merged = pullRequest?.state === 'merged'
  const mergedAge = merged ? relativeAge(pullRequest.mergedAt) : undefined
  const aheadCount = repository.ahead ?? 0
  const pushable = repository.remote !== undefined && repository.detached !== true && (aheadCount > 0 || repository.upstream === false)
  const hasDiff = repository.diff !== undefined && (repository.diff.additions > 0 || repository.diff.deletions > 0)
  if (repository.status !== 'ready') {
    return (
      <div style={styles.repositoryBarFrame}>
        <div style={styles.repositoryBar}>
          <span style={styles.repositoryPrIcon}><PullRequestIcon /></span>
          <span style={styles.repositoryPrimary}>{repository.status === 'not-repository' ? t('repositoryNotGit') : t('repositoryUnavailable')}</span>
        </div>
      </div>
    )
  }
  return (
    <div style={styles.repositoryBarFrame}>
      <div style={{ ...styles.repositoryBar, ...(merged ? styles.repositoryBarMerged : {}) }}>
        {openOverview === undefined
          ? <span style={{ ...styles.repositoryPrIcon, ...(merged ? styles.repositoryPrIconMerged : {}) }}><PullRequestIcon merged={merged} /></span>
          : <button type="button" style={{ ...styles.repositoryPrIcon, ...(merged ? styles.repositoryPrIconMerged : {}), ...styles.repositoryPrIconButton }} aria-label={t('overviewOpen')} title={t('overviewOpen')} onClick={openOverview}><PullRequestIcon merged={merged} /></button>}
        <PullRequestLink repository={repository} t={t} />
        {repository.remote === undefined ? null : <span style={styles.repositoryRemote}>{repositoryName(repository.remote)}</span>}
        <span style={styles.repositoryBranch}>{branch}</span>
        {repository.worktree === true ? <span style={styles.repositoryWorktree}>{t('repositoryWorktree')}</span> : null}
        <span style={styles.repositoryStatusItems}>
          {hasDiff || pushable ? (
            <button type="button" style={{ ...styles.diffTrigger, ...(merged ? styles.diffTriggerMuted : {}) }} onClick={openDiff} aria-label={t('diffOpen')}>
              {hasDiff && repository.diff !== undefined ? <>
                <span style={merged ? styles.diffAddMuted : styles.diffAdd}>+{repository.diff.additions}</span>
                <span style={merged ? styles.diffDeleteMuted : styles.diffDelete}>−{repository.diff.deletions}</span>
              </> : null}
              {pushable ? <span style={merged ? styles.diffAheadMuted : styles.diffAhead}>↑{aheadCount > 0 ? aheadCount : ''}</span> : null}
            </button>
          ) : null}
          {pullRequest === undefined ? null : merged ? (<>
            <span style={styles.repositoryMergedStatus}>
              <span style={styles.repositoryMergedDot} aria-hidden="true" />
              {t('repositoryState_merged')}
              {mergedAge === undefined ? null : <span style={styles.repositoryMergedAge}>· {t('repositoryMergedAgo', { age: mergedAge })}</span>}
            </span>
            <CleanupControl repository={repository} t={t} {...(deleteWorkspace === undefined ? {} : { deleteWorkspace })} />
          </>) : <>
            {pullRequest.checks === 'failing'
              ? <FailingChecksControl sessionId={sessionId} pullNumber={pullRequest.number} t={t} {...(submitPrompt === undefined ? {} : { submitPrompt })} />
              : pullRequest.checks === 'none' ? null : <StatusGlyph
                  label={t(`repositoryChecks_${pullRequest.checks}` as ClaudeCodeSettingsKey)}
                  tone={pullRequest.checks === 'passing' ? 'success' : 'warning'}
                ><ChecksGlyph state={pullRequest.checks} /></StatusGlyph>}
            {pullRequest.review === 'none' ? null : <StatusGlyph
              label={t(`repositoryReview_${pullRequest.review}` as ClaudeCodeSettingsKey)}
              tone={pullRequest.review === 'approved' ? 'success' : pullRequest.review === 'changes-requested' ? 'error' : 'neutral'}
            ><ReviewGlyph /></StatusGlyph>}
            <AutoFixControl sessionId={sessionId} repository={repository} running={running} t={t} {...(submitPrompt === undefined ? {} : { submitPrompt })} />
            <UpdateBranchControl sessionId={sessionId} repository={repository} t={t} {...(submitPrompt === undefined ? {} : { submitPrompt })} />
            <MergePullRequestControl sessionId={sessionId} repository={repository} t={t} />
          </>}
        </span>
      </div>
    </div>
  )
}
