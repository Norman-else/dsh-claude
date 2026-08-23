import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutline14,
  IconCloseOutline16,
  IconFullscreenOutline16,
  Menu,
  Modal,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepositoryActionKind, RepositoryActionPreview } from '../repository-actions.ts'
import type { RepositoryStatus } from '../repository-status.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import { executeRepositoryAction, generateCommitMessage, loadRepositoryActionPreview } from './repository-action-api.ts'
import * as styles from './styles.ts'

export interface ClaudeDiffPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  sessionId: string
  maximized: boolean
  closeDetails: () => void
  toggleMaximized: () => void
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

interface NumberedDiffLine {
  readonly line: string
  readonly kind: 'add' | 'delete' | 'hunk' | 'context' | 'collapsed'
  readonly oldLine?: number
  readonly newLine?: number
}

export function numberDiffLines(lines: readonly string[]): readonly NumberedDiffLine[] {
  const numbered: NumberedDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let previousOldEnd: number | undefined
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (hunk !== null) {
      const nextOld = Number(hunk[1])
      if (previousOldEnd !== undefined && nextOld > previousOldEnd) {
        numbered.push({ line: `${nextOld - previousOldEnd} unmodified lines`, kind: 'collapsed' })
      }
      oldLine = nextOld
      newLine = Number(hunk[3])
      previousOldEnd = nextOld + Number(hunk[2] ?? 1)
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
  return numbered
}

function DiffLine({ entry }: { entry: NumberedDiffLine }) {
  const style = entry.kind === 'add'
    ? styles.diffLineAdd
    : entry.kind === 'delete' ? styles.diffLineDelete : entry.kind === 'hunk' || entry.kind === 'collapsed' ? styles.diffLineHunk : styles.diffLineContext
  const lineNumber = entry.oldLine === undefined && entry.newLine === undefined
    ? ''
    : entry.oldLine === undefined ? String(entry.newLine) : entry.newLine === undefined ? String(entry.oldLine) : String(entry.newLine)
  return <div style={{ ...styles.diffLine, ...style }}><span style={styles.diffLineNumber}>{lineNumber}</span><span style={styles.diffLineMarker}>{entry.kind === 'add' ? '+' : entry.kind === 'delete' ? '−' : entry.kind === 'collapsed' ? '⌄' : ' '}</span><span>{entry.kind === 'collapsed' ? entry.line : entry.line.slice(entry.kind === 'hunk' ? 0 : 1)}</span></div>
}

function DiffFileSection({ file, initiallyOpen }: { file: DiffFile; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <section style={styles.diffFile}>
      <button type="button" style={styles.diffFileHeader} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span style={{ ...styles.chevron, ...(open ? styles.chevronOpen : {}) }}>›</span>
        <span style={styles.diffFilePath}>{file.path}</span>
        <span style={styles.diffFileStats}><span style={styles.diffAdd}>+{file.additions}</span><span style={styles.diffDelete}>−{file.deletions}</span></span>
      </button>
      {open ? <div style={styles.diffCode}>{numberDiffLines(file.lines).map((entry, index) => <DiffLine key={`${index}:${entry.line}`} entry={entry} />)}</div> : null}
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

function actionLabel(action: RepositoryActionKind, t: ClaudeDiffPanelInjected['t']): string {
  return action === 'commit' ? t('diffCommit') : action === 'commit-push' ? t('diffCommitPush') : t('diffCreatePr')
}

export type RepositoryActionAvailability = Readonly<Record<RepositoryActionKind, boolean>>

export function repositoryActionAvailability(
  repository: Pick<RepositoryStatus, 'status' | 'dirty' | 'detached' | 'remote' | 'pullRequest'> | undefined,
): RepositoryActionAvailability {
  const committable = repository?.status === 'ready' && repository.dirty === true && repository.detached !== true
  const hasRemote = repository?.remote !== undefined
  const hasOpenPullRequest = repository?.pullRequest?.state === 'open'
  return {
    'commit': committable,
    'commit-push': committable && hasRemote,
    'create-pr': committable && hasRemote && !hasOpenPullRequest,
  }
}

function RestorePanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 5h3V2h1.4v4.4H1.5V5Zm9.9-3h1.4v3h3v1.4h-4.4V2ZM1.5 9.6h4.4V14H4.5v-3h-3V9.6Zm9.9 0h4.4V11h-3v3h-1.4V9.6Z" />
    </svg>
  )
}

export function ClaudeDiffPanel({ useClaudeProjection, t, sessionId, maximized, closeDetails, toggleMaximized }: ClaudeDiffPanelProps) {
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
  const actionController = useRef<AbortController>()
  const closeDialog = useCallback(() => {
    if (dialog?.submitting === true) return
    actionController.current?.abort()
    actionController.current = undefined
    setDialog(undefined)
  }, [dialog?.submitting])
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
    if (dialog?.preview === undefined || message.trim().length === 0) return
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
  useEffect(() => () => actionController.current?.abort(), [])
  useEffect(() => {
    if (!projection.owned || repository?.status !== 'ready' || diff === undefined) closeDetails()
  }, [closeDetails, diff, projection.owned, repository?.status])
  if (!projection.owned || repository?.status !== 'ready' || diff === undefined) return null
  const branch = repository.detached === true ? t('repositoryDetached') : repository.branch ?? t('repositoryUnknownBranch')
  const availability = repositoryActionAvailability(repository)
  const anyActionAvailable = availability['commit'] || availability['commit-push'] || availability['create-pr']
  const menuItems: readonly MenuEntry[] = [
    { id: 'commit', label: t('diffCommit'), disabled: !availability['commit'] },
    { id: 'commit-push', label: t('diffCommitPush'), disabled: !availability['commit-push'] },
    { id: 'create-pr', label: t('diffCreatePr'), disabled: !availability['create-pr'] },
  ]
  const completed = dialog?.commit !== undefined && dialog.error === undefined
  return (
    <>
      <style data-dsh-claude-repository-modal-styles>{styles.diffModalCss}{styles.panelIconButtonCss}</style>
      <div style={{ ...styles.diffPanel, ...(maximized ? styles.diffPanelMaximized : {}) }}>
        <header style={styles.diffHeader}>
          <div style={styles.diffHeaderTitle}><span style={styles.diffHeaderBranch}>{branch}</span><span aria-hidden="true">›</span><span>{t('diffWorkingTree')}</span></div>
          <div style={styles.diffHeaderActions}>
            <div style={styles.diffSplitButton}>
              <button type="button" style={{ ...styles.diffCommitButton, ...(availability['commit'] ? {} : styles.diffActionDisabled) }} disabled={!availability['commit']} onClick={() => openAction('commit')}>{t('diffCommit')}</button>
              <Menu open={menuOpen} items={menuItems} onSelect={(id: string) => { if (availability[id as RepositoryActionKind]) openAction(id as RepositoryActionKind) }} onClose={() => setMenuOpen(false)} align="end" portal anchor={
                <button type="button" style={{ ...styles.diffCommitMenuButton, ...(anyActionAvailable ? {} : styles.diffActionDisabled) }} disabled={!anyActionAvailable} aria-label={t('diffCommitMenu')} aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><IconChevronDownOutline14 /></button>
              } />
            </div>
            <button type="button" className={styles.panelIconButtonClass} aria-label={maximized ? t('diffRestore') : t('diffMaximize')} onClick={toggleMaximized}>{maximized ? <RestorePanelIcon /> : <IconFullscreenOutline16 />}</button>
            <button type="button" className={styles.panelIconButtonClass} aria-label={t('diffClose')} onClick={closeDetails}><IconCloseOutline16 /></button>
          </div>
        </header>
        <div style={styles.diffSummary}>
          <span>{t('diffFiles', { count: diff.files })}</span>
          <span style={styles.diffAdd}>+{diff.additions}</span>
          <span style={styles.diffDelete}>−{diff.deletions}</span>
        </div>
        <div style={styles.diffBody}>
          {diff.truncated ? <p style={styles.diffNotice}>{t('diffTruncated')}</p> : null}
          {files.length === 0 ? <p style={styles.diffEmpty}>{t('diffEmpty')}</p> : files.map((file, index) => (
            <DiffFileSection key={file.path} file={file} initiallyOpen={index === 0} />
          ))}
        </div>
      </div>
      <Modal className="dshClaudeRepositoryActionModal" contentClassName="dshClaudeRepositoryActionModalContent" open={dialog !== undefined} onClose={closeDialog} title={dialog === undefined ? t('diffCommit') : actionLabel(dialog.action, t)} closeLabel={t('diffCancel')} description={t('diffConfirmDescription')} footer={
        <div style={styles.diffModalFooter}>
          <button type="button" style={{ ...styles.button, ...styles.diffModalButton }} disabled={dialog?.submitting === true} onClick={closeDialog}>{completed ? t('diffDone') : t('diffCancel')}</button>
          {!completed ? <button type="button" style={{ ...styles.primaryButton, ...styles.diffModalButton }} disabled={dialog?.loading === true || dialog?.submitting === true || dialog?.preview === undefined || message.trim() === ''} onClick={() => void confirm()}>{dialog?.submitting === true ? t('diffSubmitting') : t('diffConfirm')}</button> : null}
        </div>
      }>
        {dialog?.loading === true ? <p style={styles.diffModalStatus}>{t('diffGeneratingMessage')}</p> : null}
        {dialog?.preview !== undefined ? <div style={styles.diffModalBody}>
          <div style={styles.diffModalMeta}><strong style={styles.diffModalMetaText} title={dialog.preview.branch}>{dialog.preview.branch}</strong><span style={styles.diffModalFileState}>{t('diffFiles', { count: dialog.preview.files.length })}</span></div>
          <div style={styles.diffModalFiles}>{dialog.preview.files.map(file => <div key={file.path} style={styles.diffModalFile}><span style={styles.diffModalFilePath} title={file.path}>{file.path}</span><span style={styles.diffModalFileState}>{file.untracked ? t('diffUntracked') : file.staged && file.unstaged ? t('diffStagedUnstaged') : file.staged ? t('diffStaged') : t('diffUnstaged')}</span></div>)}</div>
          <label style={styles.diffModalCheckbox}><input type="checkbox" checked={includeUnstaged} disabled={!dialog.preview.hasUnstaged && !dialog.preview.hasUntracked} onChange={event => setIncludeUnstaged(event.currentTarget.checked)} />{t('diffIncludeUnstaged')}</label>
          <label style={styles.diffModalField}>{t('diffCommitMessage')}<textarea style={styles.diffModalTextarea} value={message} maxLength={512} onChange={event => setMessage(event.currentTarget.value)} /></label>
          {dialog.action === 'create-pr' ? <>
            <label style={styles.diffModalField}>{t('diffPrTitle')}<input style={styles.diffModalTextInput} value={prTitle} maxLength={256} onChange={event => setPrTitle(event.currentTarget.value)} /></label>
            <label style={styles.diffModalField}>{t('diffPrBase')}<input style={styles.diffModalTextInput} value={baseBranch} maxLength={512} placeholder={t('diffPrBaseDefault')} onChange={event => setBaseBranch(event.currentTarget.value)} /></label>
            <label style={styles.diffModalField}>{t('diffPrDescription')}<textarea style={{ ...styles.diffModalTextarea, minHeight: 240 }} value={prBody} maxLength={8192} onChange={event => setPrBody(event.currentTarget.value)} /></label>
            <label style={styles.diffModalCheckbox}><input type="checkbox" checked={draft} onChange={event => setDraft(event.currentTarget.checked)} />{t('diffPrDraft')}</label>
          </> : null}
          {dialog.commit !== undefined ? <p style={styles.diffModalSuccess}>{t('diffCommitCompleted', { commit: dialog.commit.slice(0, 8) })}</p> : null}
          {dialog.pullRequestUrl !== undefined ? <a href={dialog.pullRequestUrl} target="_blank" rel="noopener noreferrer">{t('diffOpenPr')}</a> : null}
        </div> : null}
        {dialog?.error !== undefined ? <p role="alert" style={styles.diffModalError}>{dialog.error}{dialog.commit === undefined ? '' : ` ${t('diffCommitPreserved', { commit: dialog.commit.slice(0, 8) })}`}</p> : null}
      </Modal>
    </>
  )
}
