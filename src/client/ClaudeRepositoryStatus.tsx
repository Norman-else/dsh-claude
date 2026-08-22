import { useEffect, useRef, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepositoryStatus } from '../repository-status.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'

export interface ClaudeRepositoryStatusInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  openDiff: () => void
}

export interface ClaudeRepositoryStatusProps extends ClaudeRepositoryStatusInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  useSessions: SnapshotSelectorHook<{ readonly byId: Readonly<Record<string, { readonly blank: boolean } | undefined>> }>
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
      : [
          pullRequest.draft ? t('repositoryPrDraft', { number: pullRequest.number }) : t('repositoryPr', { number: pullRequest.number }),
          t(`repositoryChecks_${pullRequest.checks}` as ClaudeCodeSettingsKey),
          t(`repositoryReview_${pullRequest.review}` as ClaudeCodeSettingsKey),
        ]),
  ]
}

function StatusItem({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'error' }) {
  const toneStyle = tone === 'success'
    ? styles.repositoryItemSuccess
    : tone === 'warning' ? styles.repositoryItemWarning : tone === 'error' ? styles.repositoryItemError : {}
  return <span style={{ ...styles.repositoryItem, ...toneStyle }}><span style={styles.repositoryItemDot} aria-hidden="true" />{label}</span>
}

function PullRequestIcon({ size = 16 }: { size?: number }) {
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
  const age = relativeAge(pullRequest.createdAt)
  return (
    <span role="tooltip" style={styles.repositoryPrHoverCard}>
      <span style={styles.repositoryPrHoverTop}>
        <span style={styles.repositoryPrStateBadge}><PullRequestIcon size={13} />{t(`repositoryState_${pullRequest.state}` as ClaudeCodeSettingsKey)}</span>
        <span style={styles.repositoryPrHoverRepo}>{repositoryName(repository.remote)} #{pullRequest.number}</span>
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
        style={styles.repositoryPrLink}
        aria-label={t('repositoryOpenPr', { number: pullRequest.number })}
      >#{pullRequest.number}</a>
    </span>
  )
}

export function ClaudeRepositoryStatus({ sessionId, useSessions, useClaudeProjection, t, openDiff }: ClaudeRepositoryStatusProps) {
  const blank = useSessions(value => value.byId[sessionId]?.blank === true)
  const projection = useClaudeProjection(value => value)
  const repository = projection.repository
  if (blank || !projection.owned || repository === undefined) return null
  const branch = repository.detached === true ? t('repositoryDetached') : repository.branch ?? t('repositoryUnknownBranch')
  const pullRequest = repository.pullRequest
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
      <div style={styles.repositoryBar}>
        <span style={styles.repositoryPrIcon}><PullRequestIcon /></span>
        <PullRequestLink repository={repository} t={t} />
        {repository.remote === undefined ? null : <span style={styles.repositoryRemote}>{repositoryName(repository.remote)}</span>}
        <span style={styles.repositoryBranch}>{branch}</span>
        {repository.worktree === true ? <span style={styles.repositoryWorktree}>{t('repositoryWorktree')}</span> : null}
        <span style={styles.repositoryStatusItems}>
          {repository.diff !== undefined && (repository.diff.additions > 0 || repository.diff.deletions > 0) ? (
            <button type="button" style={styles.diffTrigger} onClick={openDiff} aria-label={t('diffOpen')}>
              <span style={styles.diffAdd}>+{repository.diff.additions}</span>
              <span style={styles.diffDelete}>−{repository.diff.deletions}</span>
            </button>
          ) : null}
          {pullRequest === undefined ? null : <>
            <StatusItem
              label={t(`repositoryChecks_${pullRequest.checks}` as ClaudeCodeSettingsKey)}
              tone={pullRequest.checks === 'passing' ? 'success' : pullRequest.checks === 'failing' ? 'error' : pullRequest.checks === 'pending' ? 'warning' : 'neutral'}
            />
            <StatusItem
              label={t(`repositoryReview_${pullRequest.review}` as ClaudeCodeSettingsKey)}
              tone={pullRequest.review === 'approved' ? 'success' : pullRequest.review === 'changes-requested' ? 'error' : 'neutral'}
            />
          </>}
        </span>
      </div>
    </div>
  )
}
