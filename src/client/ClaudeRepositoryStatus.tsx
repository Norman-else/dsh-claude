import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, Menu, Modal, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepositoryMergeMethod } from '../repository-actions.ts'
import type { RepositoryPullRequestStatus, RepositoryStatus } from '../repository-status.ts'
import { executeRepositoryAction, loadRepositoryActionPreview } from './repository-action-api.ts'
import { useActionToast } from './action-toast.tsx'
import { cleanupMergedRepository } from './repository-setup-api.ts'
import { relativeAge } from './relative-age.ts'
import { branchLabel, repositoryLabel } from './branch-label.ts'
import { composeChecksPrompt, composeConflictsPrompt, loadFailingChecks, loadPullRequestThreads, type FailingCheck, type PullRequestReviewThread } from './pr-feedback-api.ts'
import { AUTO_FIX_INTERVAL_MS, autoFixEnabled, autoFixMemory, planAutoFix, rememberAutoFix, setAutoFixEnabled } from './auto-fix.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'
import { CLAUDE_COMPOSER_BAR_ATTRIBUTE } from './boot-check.ts'

export interface ClaudeRepositoryStatusInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Open the diff panel, on another checkout the session wrote into when `root` is given. */
  openDiff: (root?: string) => void
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
    branchLabel(repository, t),
    ...(repository.worktree === true ? [t('repositoryWorktree')] : []),
    ...(repository.operation === undefined
      ? []
      : [(repository.conflicts ?? []).length > 0
          ? t('conflictBadge', { operation: t(`conflictOperation_${repository.operation}` as ClaudeCodeSettingsKey), count: (repository.conflicts ?? []).length })
          : t('conflictBadgeReady', { operation: t(`conflictOperation_${repository.operation}` as ClaudeCodeSettingsKey) })]),
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
/** A prompt about a linked checkout says which one, so Claude does not
 *  apply it to the session's own. */
function linkedPreamble(repository: RepositoryStatus, root: string | undefined, t: ClaudeRepositoryStatusInjected['t']): string {
  return root === undefined ? '' : `${t('linkedRepositoryPrompt', { root, branch: repository.branch ?? '' })}\n\n`
}

export function AutoFixControl({ sessionId, repository, root, running, t, submitPrompt }: {
  sessionId: string
  repository: RepositoryStatus
  /** A linked checkout to watch instead of the session's own. */
  root?: string | undefined
  /** Whether a turn is in flight; the watcher only submits into an idle session. */
  running: boolean
  t: ClaudeRepositoryStatusInjected['t']
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}) {
  const pullRequest = repository.pullRequest
  const open = pullRequest?.state === 'open'
  const number = pullRequest?.number
  const checks = pullRequest?.checks
  // The watcher's switch and memory are per checkout, not per session.
  const scope = root === undefined ? sessionId : `${sessionId}#${root}`
  const [enabled, setEnabled] = useState(() => autoFixEnabled(scope))
  useEffect(() => { setEnabled(autoFixEnabled(scope)) }, [scope])
  // Submitting while a turn runs would queue or steer (interrupt) it depending
  // on the user's Enter-while-busy setting, so wait for idle instead; the
  // running flip re-arms the effect and polls immediately when the turn ends.
  useEffect(() => {
    if (!enabled || !open || running || number === undefined || submitPrompt === undefined) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const [comments, failing] = await Promise.all([
        loadPullRequestThreads(sessionId, number, undefined, root).catch((): readonly PullRequestReviewThread[] => []),
        checks === 'failing' ? loadFailingChecks(sessionId, number, undefined, root).catch((): readonly FailingCheck[] => []) : Promise.resolve<readonly FailingCheck[]>([]),
      ])
      if (cancelled) return
      const plan = planAutoFix(autoFixMemory(scope), comments, failing)
      // A non-empty user draft defers this round instead of clobbering it.
      if (plan.prompt !== undefined && submitPrompt(`${linkedPreamble(repository, root, t)}${plan.prompt}`, 'idle')) rememberAutoFix(scope, plan.memory)
    }
    void tick()
    const timer = setInterval(() => { void tick() }, AUTO_FIX_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [checks, enabled, number, open, repository, root, running, scope, sessionId, submitPrompt, t])
  if (!open || submitPrompt === undefined) return null
  const toggle = (): void => {
    const next = !enabled
    setEnabled(next)
    setAutoFixEnabled(scope, next)
  }
  return (
    <Tooltip label={`${t('autoFixLabel')} · ${t('autoFixTitle')}`} side="top" delayMs={250} maxWidth={320}>
      <button
        type="button"
        role="switch"
        className={styles.repositoryAutoFixClass}
        aria-checked={enabled}
        aria-label={t('autoFixLabel')}
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

export function FailingChecksControl({ sessionId, repository, root, t, submitPrompt }: {
  sessionId: string
  repository: RepositoryStatus & { readonly pullRequest: RepositoryPullRequestStatus }
  /** A linked checkout the pull request belongs to. */
  root?: string | undefined
  t: ClaudeRepositoryStatusInjected['t']
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}) {
  const pullNumber = repository.pullRequest.number
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
    void loadFailingChecks(sessionId, pullNumber, aborter.signal, root).then(value => {
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
            <button type="button" style={styles.repositoryChecksFix} onClick={() => { submitPrompt(`${linkedPreamble(repository, root, t)}${composeChecksPrompt(checks)}`); setOpen(false) }}>{t('checksCardFix')}</button>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

interface ResolveDialogState {
  readonly submitting: boolean
  readonly confirmAbort: boolean
  readonly push: boolean
  readonly error?: string
}

/** The way out of a stopped merge or rebase. A rebase detaches HEAD, which
 *  hides every other control on this bar, and the update-branch dialog that
 *  started it takes its conflict list along when it closes -- so this one is
 *  mounted from repository state instead, and survives being dismissed. */
export function ConflictControl({ sessionId, repository, root, t, report, submitPrompt }: {
  sessionId: string
  repository: RepositoryStatus
  root?: string | undefined
  t: ClaudeRepositoryStatusInjected['t']
  report: (text: string) => void
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}) {
  const [dialog, setDialog] = useState<ResolveDialogState>()
  const operation = repository.operation
  if (operation === undefined) return null
  const conflicts = repository.conflicts ?? []
  const operationName = t(`conflictOperation_${operation}` as ClaudeCodeSettingsKey)
  const closeDialog = (): void => {
    if (dialog?.submitting !== true) setDialog(undefined)
  }
  const run = (action: 'resolve-continue' | 'resolve-abort'): void => {
    if (dialog === undefined || dialog.submitting) return
    const { error: _error, ...pending } = dialog
    setDialog({ ...pending, submitting: true })
    void executeRepositoryAction(sessionId, {
      action,
      fingerprint: '',
      message: '',
      includeUnstaged: false,
      push: dialog.push,
    }, root).then(result => {
      // A rebase replays commit by commit, so continuing can stop again on the
      // next one: the bar picks the new conflicts up, the panel stays put.
      if (result.conflicts !== undefined && result.conflicts.length > 0) {
        setDialog({ ...pending, submitting: false, confirmAbort: false })
        return
      }
      report(action === 'resolve-abort'
        ? t('conflictAborted', { operation: operationName })
        : t(result.pushed ? 'conflictPushed' : 'conflictContinued', { operation: operationName }))
      setDialog(undefined)
    }, (reason: unknown) => {
      setDialog({ ...pending, submitting: false, error: reason instanceof Error ? reason.message : t('diffActionFailed') })
    })
  }
  const openDialog = (): void => {
    setDialog({
      submitting: false,
      confirmAbort: false,
      // The branch this finishes on is a pull request branch that already lives
      // on the remote, so pushing it is the rest of the interrupted update.
      push: repository.remote !== undefined && repository.pullRequest?.state === 'open',
    })
  }
  return (
    <>
      <button
        type="button"
        style={styles.repositoryConflictTrigger}
        title={t('conflictDescription', { operation: operationName })}
        onClick={openDialog}
      >{conflicts.length > 0
          ? t('conflictBadge', { operation: operationName, count: conflicts.length })
          : t('conflictBadgeReady', { operation: operationName })}</button>
      {dialog === undefined ? null : <style data-dsh-claude-repository-modal-styles>{styles.diffModalCss}</style>}
      <Modal className="dshClaudeRepositoryActionModal" contentClassName="dshClaudeRepositoryActionModalContent" open={dialog !== undefined} onClose={closeDialog} title={t('conflictTitle')} closeLabel={t('diffCancel')} description={t('conflictDescription', { operation: operationName })} footer={
        <div style={styles.diffModalFooter}>
          <button
            type="button"
            style={{ ...styles.button, ...styles.diffModalButton }}
            disabled={dialog?.submitting === true}
            onClick={() => { if (dialog?.confirmAbort === true) run('resolve-abort'); else setDialog(current => current === undefined ? current : { ...current, confirmAbort: true }) }}
          >{t('conflictAbort', { operation: operationName })}</button>
          <button
            type="button"
            style={{ ...styles.primaryButton, ...styles.diffModalButton }}
            disabled={dialog?.submitting === true || conflicts.length > 0}
            onClick={() => run('resolve-continue')}
          >{dialog?.submitting === true ? t('diffSubmitting') : t('conflictContinue', { operation: operationName })}</button>
        </div>
      }>
        {dialog === undefined ? null : <div style={styles.diffModalBody}>
          <div style={styles.diffModalMeta}>
            <strong style={styles.diffModalMetaText}>{operationName} · {branchLabel(repository, t)}</strong>
            <span style={styles.diffModalFileState}>{conflicts.length > 0 ? t('conflictFiles') : t('conflictReady')}</span>
          </div>
          {conflicts.length === 0 ? null : <ul style={styles.diffModalConflicts}>{conflicts.map(file => <li key={file}>{file}</li>)}</ul>}
          {conflicts.length === 0 || submitPrompt === undefined ? null : (
            <button type="button" style={styles.diffModalConflictResolve} onClick={() => { submitPrompt(`${linkedPreamble(repository, root, t)}${composeConflictsPrompt(conflicts, operation, repository.pullRequest?.baseBranch)}`); closeDialog() }}>{t('conflictResolve')}</button>
          )}
          {repository.remote === undefined ? null : (
            <label style={styles.diffModalCheckbox}>
              <input type="checkbox" checked={dialog.push} disabled={dialog.submitting} onChange={event => { const { checked } = event.currentTarget; setDialog(current => current === undefined ? current : { ...current, push: checked }) }} />
              {t('conflictPush')}
            </label>
          )}
          {!dialog.confirmAbort ? null : <p role="alert" style={styles.diffModalStatus}>{t('conflictAbortConfirm', { operation: operationName })}</p>}
          {dialog.error === undefined ? null : <p role="alert" style={styles.diffModalError}>{dialog.error}</p>}
        </div>}
      </Modal>
    </>
  )
}

interface UpdateDialogState {
  readonly loading: boolean
  readonly submitting: boolean
  readonly fingerprint?: string
  readonly error?: string
  readonly conflicts?: readonly string[]
}

/** The trigger only shows on a clean branch that is behind its base -- but a
 *  conflicted rebase leaves the tree dirty on a detached HEAD, so an open
 *  dialog (and its resolve button) has to outlive that. */
export function updateBranchMounted(repository: RepositoryStatus, dialogOpen: boolean): boolean {
  const pullRequest = repository.pullRequest
  if (pullRequest?.baseBranch === undefined) return false
  return dialogOpen || (pullRequest.state === 'open' && repository.detached !== true
    && repository.dirty !== true && (repository.baseBehind ?? 0) > 0)
}

export function UpdateBranchControl({ sessionId, repository, root, t, report, submitPrompt }: {
  sessionId: string
  repository: RepositoryStatus
  root?: string | undefined
  t: ClaudeRepositoryStatusInjected['t']
  report: (text: string) => void
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
}) {
  const [dialog, setDialog] = useState<UpdateDialogState>()
  const [method, setMethod] = useState<'merge' | 'rebase'>('rebase')
  const controller = useRef<AbortController>()
  const pullRequest = repository.pullRequest
  const base = pullRequest?.baseBranch
  const behind = repository.baseBehind ?? 0
  useEffect(() => () => controller.current?.abort(), [])
  if (pullRequest === undefined || base === undefined) return null
  if (!updateBranchMounted(repository, dialog !== undefined)) return null
  const openDialog = (): void => {
    controller.current?.abort()
    setDialog({ loading: true, submitting: false })
    const aborter = new AbortController()
    controller.current = aborter
    void loadRepositoryActionPreview(sessionId, aborter.signal, root).then(preview => {
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
      mergeMethod: method,
    }, root).then(result => {
      // Conflicts are work, not news: they keep the dialog and its resolve
      // action. A clean update has nothing left to say here.
      if (result.conflicts !== undefined && result.conflicts.length > 0) {
        setDialog({ ...pending, submitting: false, conflicts: result.conflicts })
        return
      }
      report(t('diffUpdateBranchCompleted', { commit: result.commit.slice(0, 8) }))
      setDialog(undefined)
    }, (reason: unknown) => {
      setDialog({ ...pending, submitting: false, error: reason instanceof Error ? reason.message : t('diffActionFailed') })
    })
  }
  const settled = dialog?.conflicts !== undefined
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
          {(['rebase', 'merge'] as const).map(option => (
            <label key={option} style={styles.diffModalCheckbox}>
              <input type="radio" name="dsh-claude-update-branch-method" value={option} checked={method === option} disabled={settled || dialog.submitting} onChange={() => setMethod(option)} />
              {t(`diffUpdateBranch_${option}`, { base })}
            </label>
          ))}
          {dialog.conflicts === undefined ? null : <>
            <p style={styles.diffModalStatus}>{t('diffUpdateBranchConflicts')}</p>
            <ul style={styles.diffModalConflicts}>{dialog.conflicts.map(file => <li key={file}>{file}</li>)}</ul>
            {submitPrompt === undefined ? null : (
              <button type="button" style={styles.diffModalConflictResolve} onClick={() => { submitPrompt(`${linkedPreamble(repository, root, t)}${composeConflictsPrompt(dialog.conflicts ?? [], method, base)}`); closeDialog() }}>{t('diffUpdateBranchResolve')}</button>
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
  readonly error?: string
}

/** After a merge: remove the worktree (or switch a plain checkout back to
 *  base), delete the merged branch, and drop the DSH workspace along with the
 *  sessions it held. */
export function CleanupControl({ repository, t, report, deleteWorkspace }: {
  repository: RepositoryStatus
  t: ClaudeRepositoryStatusInjected['t']
  report: (text: string) => void
  deleteWorkspace?: () => Promise<void>
}) {
  const [dialog, setDialog] = useState<CleanupDialogState>()
  const pullRequest = repository.pullRequest
  const base = pullRequest?.baseBranch
  // Merged: the branch is done, base is known. No pull request at all: only a
  // clean worktree is offered -- a plain checkout with no pull request is the
  // user's own clone -- and the Host refuses it unless its commits are pushed.
  const merged = pullRequest?.state === 'merged' && base !== undefined
  const unmerged = pullRequest === undefined && repository.worktree === true && repository.dirty !== true
  if ((!merged && !unmerged) || repository.root === undefined || repository.detached === true) return null
  const root = repository.root
  const closeDialog = (): void => { if (dialog?.submitting !== true) setDialog(undefined) }
  const confirm = (): void => {
    setDialog({ submitting: true })
    // A pull request read by number: its clone is back on base already, so
    // the branch to delete has to be named rather than read off HEAD.
    const named = repository.pullRequestOnly === true || unmerged ? repository.branch : undefined
    void cleanupMergedRepository(root, base, named, unmerged).then(async result => {
      report(t('cleanupCompleted', { branch: result.branch }))
      setDialog(undefined)
      if (result.mode === 'worktree' && deleteWorkspace !== undefined) await deleteWorkspace()
    }, (reason: unknown) => {
      setDialog({ submitting: false, error: reason instanceof Error ? reason.message : t('diffActionFailed') })
    })
  }
  return (
    <>
      <button type="button" style={styles.repositoryUpdateTrigger} title={t('cleanupTitle')} onClick={() => { setDialog({ submitting: false }) }}>{t('cleanupButton')}</button>
      {dialog === undefined ? null : <style data-dsh-claude-repository-modal-styles>{styles.diffModalCss}</style>}
      <Modal className="dshClaudeRepositoryActionModal" contentClassName="dshClaudeRepositoryActionModalContent" open={dialog !== undefined} onClose={closeDialog} title={t('cleanupTitle')} closeLabel={t('diffCancel')} description={t(unmerged ? 'cleanupDescriptionUnmerged' : 'cleanupDescription')} footer={
        <div style={styles.diffModalFooter}>
          <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={closeDialog}>{t('diffCancel')}</button>
          <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={confirm}>{dialog?.submitting === true ? t('diffSubmitting') : t('diffConfirm')}</button>
        </div>
      }>
        {dialog === undefined ? null : <div style={styles.diffModalBody}>
          <div style={styles.diffModalMeta}>
            <strong style={styles.diffModalMetaText}>{repository.branch ?? t('repositoryUnknownBranch')}{base === undefined ? '' : ` → ${base}`}</strong>
            <span style={styles.diffModalFileState}>{repository.worktree === true ? t('repositoryWorktree') : t('repositoryLocal')}</span>
          </div>
          {dialog.error === undefined ? null : <p role="alert" style={styles.diffModalError}>{dialog.error}</p>}
        </div>}
      </Modal>
    </>
  )
}

export const MERGE_METHODS: readonly RepositoryMergeMethod[] = ['merge', 'squash', 'rebase']

interface MergeDialogState {
  readonly method: RepositoryMergeMethod
  /** Merge past branch protection; off each time the dialog opens. */
  readonly admin: boolean
  readonly loading: boolean
  readonly submitting: boolean
  readonly fingerprint?: string
  readonly error?: string
}

export function MergePullRequestControl({ sessionId, repository, root, t, report }: {
  sessionId: string
  repository: RepositoryStatus
  /** A linked checkout: the merge names the pull request, since that
   *  checkout may sit on another branch than the one it opened. */
  root?: string | undefined
  t: ClaudeRepositoryStatusInjected['t']
  report: (text: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<MergeDialogState>()
  const controller = useRef<AbortController>()
  const pullRequest = repository.pullRequest
  useEffect(() => () => controller.current?.abort(), [])
  if (pullRequest === undefined || pullRequest.state !== 'open' || pullRequest.draft || repository.detached === true) return null
  const openMerge = (method: RepositoryMergeMethod): void => {
    controller.current?.abort()
    setMenuOpen(false)
    setDialog({ method, admin: false, loading: true, submitting: false })
    const aborter = new AbortController()
    controller.current = aborter
    void loadRepositoryActionPreview(sessionId, aborter.signal, root).then(preview => {
      setDialog(current => ({ method, admin: current?.admin ?? false, loading: false, submitting: false, fingerprint: preview.fingerprint }))
    }, (error: unknown) => {
      if (!aborter.signal.aborted) setDialog(current => ({ method, admin: current?.admin ?? false, loading: false, submitting: false, error: error instanceof Error ? error.message : t('diffActionFailed') }))
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
      ...(dialog.admin ? { admin: true } : {}),
      ...(root === undefined ? {} : { pullNumber: pullRequest.number }),
    }, root).then(() => {
      report(t('diffMergeCompleted', { number: pullRequest.number }))
      setDialog(undefined)
    }, (error: unknown) => {
      setDialog({ ...pending, submitting: false, error: error instanceof Error ? error.message : t('diffActionFailed') })
    })
  }
  const items: readonly MenuEntry[] = MERGE_METHODS.map(method => ({ id: method, label: t(`diffMerge_${method}` as ClaudeCodeSettingsKey) }))
  return (
    <>
      <Menu open={menuOpen} items={items} onSelect={(id: string) => openMerge(id as RepositoryMergeMethod)} onClose={() => setMenuOpen(false)} align="end" portal anchor={
        <button type="button" style={styles.repositoryMergeTrigger} aria-label={t('repositoryMergeMenu')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}>{t('diffMergePr')}<IconChevronDownOutline14 /></button>
      } />
      {dialog === undefined ? null : <style data-dsh-claude-repository-modal-styles>{styles.diffModalCss}</style>}
      <Modal className="dshClaudeRepositoryActionModal" contentClassName="dshClaudeRepositoryActionModalContent" open={dialog !== undefined} onClose={closeDialog} title={t('diffMergePr')} closeLabel={t('diffCancel')} description={t('diffMergeDescription')} footer={
        <div style={styles.diffModalFooter}>
          <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={closeDialog}>{t('diffCancel')}</button>
          <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} disabled={dialog?.loading === true || dialog?.submitting === true || dialog?.fingerprint === undefined} onClick={confirmMerge}>{dialog?.submitting === true ? t('diffSubmitting') : t('diffConfirm')}</button>
        </div>
      }>
        {dialog === undefined ? null : <div style={styles.diffModalBody}>
          <div style={styles.diffModalMeta}>
            <strong style={styles.diffModalMetaText} title={pullRequest.title}>{t('repositoryPr', { number: pullRequest.number })} → {pullRequest.baseBranch ?? t('diffPrBaseDefault')}</strong>
            <span style={styles.diffModalFileState}>{t(`diffMerge_${dialog.method}` as ClaudeCodeSettingsKey)}</span>
          </div>
          <p style={styles.diffModalStatus}>{pullRequest.title}</p>
          <label style={styles.diffModalCheckbox}>
            <input type="checkbox" name="dsh-claude-merge-admin" checked={dialog.admin} disabled={dialog.submitting} onChange={event => { const { checked } = event.currentTarget; setDialog(current => current === undefined ? current : { ...current, admin: checked }) }} />
            {t('diffMergeAdmin')}
          </label>
          {dialog.error === undefined ? null : <p role="alert" style={styles.diffModalError}>{dialog.error}</p>}
        </div>}
      </Modal>
    </>
  )
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1" />
      <path d="M9.2 6.8a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
    </svg>
  )
}

/** Everything to the right of the branch: the diff counts and the pull
 *  request's controls. One row for the session checkout and each linked one;
 *  `root` scopes the requests to a linked checkout. */
function RepositoryControls({ sessionId, repository, root, running, t, report, openDiff, submitPrompt, deleteWorkspace }: {
  sessionId: string
  repository: RepositoryStatus
  root?: string | undefined
  running: boolean
  t: ClaudeRepositoryStatusInjected['t']
  report: (text: string) => void
  openDiff: () => void
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
  deleteWorkspace?: () => Promise<void>
}) {
  const pullRequest = repository.pullRequest
  const merged = pullRequest?.state === 'merged'
  const mergedAge = merged ? relativeAge(pullRequest.mergedAt) : undefined
  const aheadCount = repository.ahead ?? 0
  const pushable = repository.remote !== undefined && repository.detached !== true && (aheadCount > 0 || repository.upstream === false)
  const hasDiff = repository.diff !== undefined && (repository.diff.additions > 0 || repository.diff.deletions > 0)
  // A pull request read by number has no checkout on its branch: nothing to
  // rebase, nothing to clean up, and without a clone to go through, nothing
  // gh can act on either.
  const actionable = repository.pullRequestOnly !== true || root !== undefined
  const prompt = submitPrompt === undefined ? {} : { submitPrompt }
  return (
    <span style={styles.repositoryStatusItems}>
      <ConflictControl sessionId={sessionId} repository={repository} root={root} t={t} report={report} {...prompt} />
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
        <CleanupControl repository={repository} t={t} report={report} {...(deleteWorkspace === undefined ? {} : { deleteWorkspace })} />
      </>) : <>
        {pullRequest.checks === 'failing' && actionable
          ? <FailingChecksControl sessionId={sessionId} repository={{ ...repository, pullRequest }} root={root} t={t} {...prompt} />
          : pullRequest.checks === 'none' ? null : <StatusGlyph
              label={t(`repositoryChecks_${pullRequest.checks}` as ClaudeCodeSettingsKey)}
              tone={pullRequest.checks === 'passing' ? 'success' : pullRequest.checks === 'failing' ? 'error' : 'warning'}
            ><ChecksGlyph state={pullRequest.checks} /></StatusGlyph>}
        {pullRequest.review === 'none' ? null : <StatusGlyph
          label={t(`repositoryReview_${pullRequest.review}` as ClaudeCodeSettingsKey)}
          tone={pullRequest.review === 'approved' ? 'success' : pullRequest.review === 'changes-requested' ? 'error' : 'neutral'}
        ><ReviewGlyph /></StatusGlyph>}
        {actionable ? <>
          <AutoFixControl sessionId={sessionId} repository={repository} root={root} running={running} t={t} {...prompt} />
          <UpdateBranchControl sessionId={sessionId} repository={repository} root={root} t={t} report={report} {...prompt} />
          <MergePullRequestControl sessionId={sessionId} repository={repository} root={root} t={t} report={report} />
        </> : null}
      </>}
    </span>
  )
}

/** A checkout the session wrote into besides its own, stacked above the
 *  session bar so that one stays put next to the composer. The same readout
 *  and controls as the session bar, scoped to that checkout; only the
 *  workspace deletion after a clean-up stays with the session's own. */
export function LinkedRepositoryBar({ sessionId, repository, running, t, openDiff, report, submitPrompt, leading }: {
  sessionId: string
  repository: RepositoryStatus
  running: boolean
  t: ClaudeRepositoryStatusInjected['t']
  openDiff: (root?: string) => void
  report: (text: string) => void
  submitPrompt?: (draft: string, mode?: 'append' | 'idle') => boolean
  /** Something to seat ahead of the link glyph: the fold pill on the first bar. */
  leading?: ReactNode
}) {
  const key = repository.root ?? `${repository.remote ?? repository.cwd}#${repository.pullRequest?.number ?? ''}`
  if (repository.status !== 'ready') {
    return (
      <div style={{ ...styles.repositoryBar, ...styles.repositoryBarLinked }} data-dsh-claude-linked-repository={key}>
        <StatusGlyph label={t('repositoryLinked')} tone="neutral"><LinkIcon /></StatusGlyph>
        <span style={styles.repositoryPrimary}>{repositoryLabel(repository)} · {repository.status === 'not-repository' ? t('repositoryNotGit') : t('repositoryUnavailable')}</span>
      </div>
    )
  }
  const branch = branchLabel(repository, t)
  const merged = repository.pullRequest?.state === 'merged'
  return (
    <div style={{ ...styles.repositoryBar, ...styles.repositoryBarLinked, ...(merged ? styles.repositoryBarMerged : {}) }} data-dsh-claude-linked-repository={key}>
      {leading}
      <StatusGlyph label={t('repositoryLinked')} tone="neutral"><LinkIcon /></StatusGlyph>
      <PullRequestLink repository={repository} t={t} />
      <Tooltip label={repository.remote ?? repositoryLabel(repository)} side="top" delayMs={250} maxWidth={420}>
        <span style={styles.repositoryRemote}>{repositoryLabel(repository)}</span>
      </Tooltip>
      <Tooltip label={branch} side="top" delayMs={250} maxWidth={420}>
        <span style={styles.repositoryBranch}>{branch}</span>
      </Tooltip>
      {repository.worktree === true ? <span style={styles.repositoryWorktree}>{t('repositoryWorktree')}</span> : null}
      <RepositoryControls sessionId={sessionId} repository={repository} root={repository.root} running={running} t={t} report={report} openDiff={() => openDiff(repository.root)} {...(submitPrompt === undefined ? {} : { submitPrompt })} />
    </div>
  )
}

/** How many linked bars stand open before the rest fold away. */
export const LINKED_BARS_SHOWN = 3
// ponytail: module-level so the fold survives re-renders and session
// switches within one page, like the auto-fix switch next to it.
const linkedExpanded = new Map<string, boolean>()

/** The pill at the head of the first linked bar that folds and unfolds the
 *  bars past the first three: a count and a chevron, in the row with the
 *  bar's own glyphs, the words in its tooltip and accessible name. */
function LinkedFoldChip({ sessionId, hidden, expanded, onToggle, t }: {
  sessionId: string
  hidden: number
  expanded: boolean
  onToggle: () => void
  t: ClaudeRepositoryStatusInjected['t']
}) {
  const label = expanded ? t('linkedCollapse') : `${t('linkedMore', { count: hidden })} · ${t('linkedShowAll')}`
  return (
    <Tooltip label={label} side="top" delayMs={250}>
      <button type="button" style={styles.linkedFoldChip} aria-expanded={expanded} aria-label={label} data-dsh-claude-linked-fold={sessionId} onClick={onToggle}>
        {expanded ? null : <span>+{hidden}</span>}
        <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {expanded ? <path d="M2 6.5 5 3.5l3 3" /> : <path d="M2 3.5 5 6.5l3-3" />}
        </svg>
      </button>
    </Tooltip>
  )
}

export function ClaudeRepositoryStatus({ sessionId, useSessions, useClaudeProjection, t, openDiff, submitPrompt, openOverview, deleteWorkspace }: ClaudeRepositoryStatusProps) {
  const blank = useSessions(value => value.byId[sessionId]?.blank === true)
  const running = useSessions(value => value.byId[sessionId]?.running === true)
  const projection = useClaudeProjection(value => value)
  const repository = projection.repository
  // The bar outlives its controls -- a merged PR, an updated branch and a
  // cleaned-up worktree all unmount the button that did the work -- so the
  // completion notice belongs here, not inside them.
  const { toast, report } = useActionToast()
  // Every hook runs before the bar decides whether to draw: a session paints
  // once before the plugin owns it, and a hook that only appears afterwards
  // is React error 310 and a bar that never comes back.
  const [expanded, setExpanded] = useState(() => linkedExpanded.get(sessionId) ?? false)
  useEffect(() => { setExpanded(linkedExpanded.get(sessionId) ?? false) }, [sessionId])
  if (blank || !projection.owned || repository === undefined) return null
  const branch = branchLabel(repository, t)
  const merged = repository.pullRequest?.state === 'merged'
  const all = projection.repositories ?? []
  // A fan-out over many services would otherwise stack a dozen bars over the
  // transcript: past three they fold behind one row that unfolds them.
  const shown = expanded ? all : all.slice(0, LINKED_BARS_SHOWN)
  const fold = all.length > LINKED_BARS_SHOWN ? <LinkedFoldChip sessionId={sessionId} hidden={all.length - LINKED_BARS_SHOWN} expanded={expanded} t={t} onToggle={() => {
    const next = !expanded
    setExpanded(next)
    linkedExpanded.set(sessionId, next)
  }} /> : null
  const linked = shown.map((item, index) => (
    <LinkedRepositoryBar key={item.root ?? `${item.remote ?? item.cwd}#${item.pullRequest?.number ?? ''}`} sessionId={sessionId} repository={item} running={running} t={t} openDiff={openDiff} report={report} {...(submitPrompt === undefined ? {} : { submitPrompt })} {...(index === 0 && fold !== null ? { leading: fold } : {})} />
  ))
  if (repository.status !== 'ready') {
    return (
      <div style={styles.repositoryBarFrame} {...{ [CLAUDE_COMPOSER_BAR_ATTRIBUTE]: '' }}>
        {linked}
        <div style={styles.repositoryBar}>
          <span style={styles.repositoryPrIcon}><PullRequestIcon /></span>
          <span style={styles.repositoryPrimary}>{repository.status === 'not-repository' ? t('repositoryNotGit') : t('repositoryUnavailable')}</span>
        </div>
      </div>
    )
  }
  return (
    <div style={styles.repositoryBarFrame} {...{ [CLAUDE_COMPOSER_BAR_ATTRIBUTE]: '' }}>
      <style data-dsh-claude-repository-bar-styles>{styles.repositoryAutoFixCss}</style>
      {toast}
      {linked}
      <div style={{ ...styles.repositoryBar, ...(merged ? styles.repositoryBarMerged : {}) }}>
        {openOverview === undefined
          ? <span style={{ ...styles.repositoryPrIcon, ...(merged ? styles.repositoryPrIconMerged : {}) }}><PullRequestIcon merged={merged} /></span>
          : <button type="button" style={{ ...styles.repositoryPrIcon, ...(merged ? styles.repositoryPrIconMerged : {}), ...styles.repositoryPrIconButton }} aria-label={t('overviewOpen')} title={t('overviewOpen')} onClick={openOverview}><PullRequestIcon merged={merged} /></button>}
        <PullRequestLink repository={repository} t={t} />
        {repository.remote === undefined ? null : (
          <Tooltip label={repository.remote} side="top" delayMs={250} maxWidth={420}>
            <span style={styles.repositoryRemote}>{repositoryName(repository.remote)}</span>
          </Tooltip>
        )}
        <Tooltip label={branch} side="top" delayMs={250} maxWidth={420}>
          <span style={styles.repositoryBranch}>{branch}</span>
        </Tooltip>
        {repository.worktree === true ? <span style={styles.repositoryWorktree}>{t('repositoryWorktree')}</span> : null}
        <RepositoryControls sessionId={sessionId} repository={repository} running={running} t={t} report={report} openDiff={() => openDiff()} {...(submitPrompt === undefined ? {} : { submitPrompt })} {...(deleteWorkspace === undefined ? {} : { deleteWorkspace })} />
      </div>
    </div>
  )
}
