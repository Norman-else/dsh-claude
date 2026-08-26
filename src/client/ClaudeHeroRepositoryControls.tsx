import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutline16, IconCheckOutline14, IconChevronDownOutline14, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RepositoryBranchList } from '../repository-setup.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { ensureClaudeHeroPortal, locateClaudePresetSeat, removeClaudeHeroPortals } from './hero-dom-bridge.ts'
import { loadRepositoryBranches, type RepositoryPreparationStage } from './repository-setup-api.ts'
import { JiraClientError, loadJiraStatus, searchJiraTickets, type JiraTicket } from './jira-api.ts'
import * as styles from './styles.ts'

export interface BatchTicketProgress {
  ticketKey: string
  index: number
  total: number
  stage: RepositoryPreparationStage
}

export interface ClaudeHeroRepositoryControlsInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  prepare: (
    cwd: string,
    branch: string,
    worktree: boolean,
    onProgress: (stage: RepositoryPreparationStage) => void,
    ticket?: JiraTicket,
  ) => Promise<void>
  /** Kick off one worktree + session per ticket; the hero session stays put. */
  prepareMany: (
    cwd: string,
    branch: string,
    tickets: readonly JiraTicket[],
    onProgress: (progress: BatchTicketProgress) => void,
  ) => Promise<void>
}

type StandardProps = PropsRuntime<'conversation.input.dock'>

export interface ClaudeHeroRepositoryControlsProps extends StandardProps, ClaudeHeroRepositoryControlsInjected {}

function shouldInterceptKey(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.repeat || event.isComposing) return false
  const target = event.target
  return target instanceof HTMLTextAreaElement && target.closest('[data-phase="hero"]') !== null
}

function shouldInterceptClick(event: MouseEvent): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  const button = target.closest<HTMLButtonElement>('[data-phase="hero"] [data-composer-card] button')
  if (button === null || button.disabled) return false
  const card = button.closest('[data-composer-card]')
  const buttons = card === null ? [] : Array.from(card.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
  return buttons.at(-1) === button
}

export function repositoryBranchOptions(branches: RepositoryBranchList): readonly string[] {
  const local = new Set(branches.branches)
  return [...branches.branches, ...branches.remoteBranches.filter(branch => !local.has(branch))]
}

export function selectedBranchFirst(branches: readonly string[], selected: string): readonly string[] {
  return branches.includes(selected) ? [selected, ...branches.filter(branch => branch !== selected)] : branches
}

export function filterRepositoryBranches(branches: readonly string[], query: string): readonly string[] {
  const normalized = query.trim().toLocaleLowerCase()
  return normalized.length === 0
    ? branches
    : branches.filter(branch => branch.toLocaleLowerCase().includes(normalized))
}

/** Toggle a ticket's membership in the multi-select, keyed by ticket key. */
export function toggleTicketSelection(tickets: readonly JiraTicket[], ticket: JiraTicket): readonly JiraTicket[] {
  return tickets.some(item => item.key === ticket.key)
    ? tickets.filter(item => item.key !== ticket.key)
    : [...tickets, ticket]
}

export function branchMenuNavigationIndex(current: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count <= 0) return 0
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return (current + (key === 'ArrowDown' ? 1 : -1) + count) % count
}

export const WORKTREE_PROGRESS_STAGES: readonly RepositoryPreparationStage[] = [
  'inspecting',
  'fetching',
  'creating-worktree',
  'saving-worktree',
  'creating-workspace',
  'starting-session',
  'transferring-draft',
  'submitting',
]

const PROGRESS_LABEL_KEYS: Record<RepositoryPreparationStage, ClaudeCodeSettingsKey> = {
  inspecting: 'repositoryProgress_inspecting',
  fetching: 'repositoryProgress_fetching',
  'creating-worktree': 'repositoryProgress_creating-worktree',
  'saving-worktree': 'repositoryProgress_saving-worktree',
  'switching-branch': 'repositoryProgress_switching-branch',
  'creating-workspace': 'repositoryProgress_creating-workspace',
  'starting-session': 'repositoryProgress_starting-session',
  'transferring-draft': 'repositoryProgress_transferring-draft',
  submitting: 'repositoryProgress_submitting',
}

function progressLabelKey(stage: RepositoryPreparationStage): ClaudeCodeSettingsKey {
  return PROGRESS_LABEL_KEYS[stage]
}

export function WorktreeProgressCard({
  stage, error, context, t, onDismiss,
}: {
  stage: RepositoryPreparationStage
  error?: string
  /** Batch annotation shown beside the title, e.g. "PSOS-1 · 1/3". */
  context?: string
  t: ClaudeHeroRepositoryControlsInjected['t']
  onDismiss: () => void
}) {
  const current = WORKTREE_PROGRESS_STAGES.indexOf(stage)
  const visible = WORKTREE_PROGRESS_STAGES.slice(0, Math.max(0, current) + 1)
  return (
    <div role={error === undefined ? 'status' : 'alert'} aria-live="polite" style={styles.heroWorktreeProgressCard}>
      <div style={styles.heroWorktreeProgressHeader}>
        {error === undefined ? (
          <svg aria-hidden="true" viewBox="0 0 20 20" style={styles.heroWorktreeProgressSpinner}>
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
            <path d="M10 2a8 8 0 0 1 8 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2">
              <animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="0.8s" repeatCount="indefinite" />
            </path>
          </svg>
        ) : <span aria-hidden="true" style={styles.heroWorktreeProgressError}>×</span>}
        <div style={styles.heroWorktreeProgressCopy}>
          <strong style={styles.heroWorktreeProgressTitle}>
            {error === undefined ? t('repositoryProgressTitle') : t('repositoryProgressFailed')}
            {context === undefined ? null : <span style={styles.heroWorktreeProgressContext}> {context}</span>}
          </strong>
          <span style={styles.heroWorktreeProgressCurrent}>{error ?? t(progressLabelKey(stage))}</span>
        </div>
        {error === undefined ? null : (
          <button type="button" style={styles.heroWorktreeProgressDismiss} onClick={onDismiss} aria-label={t('repositoryProgressDismiss')}>×</button>
        )}
      </div>
      <div style={styles.heroWorktreeProgressSteps}>
        {visible.map((item, index) => (
          <span key={item} style={styles.heroWorktreeProgressStep}>
            <span aria-hidden="true" style={{
              ...styles.heroWorktreeProgressDot,
              ...(index < visible.length - 1 ? styles.heroWorktreeProgressDotDone : styles.heroWorktreeProgressDotActive),
            }}>{index < visible.length - 1 ? '✓' : ''}</span>
            {t(progressLabelKey(item))}
          </span>
        ))}
      </div>
    </div>
  )
}

function TicketIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 5.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1.2a1.3 1.3 0 0 0 0 2.6v1.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9.3a1.3 1.3 0 0 0 0-2.6V5.5Z" />
      <path d="M6.5 4.5v7" strokeDasharray="1.5 1.5" />
    </svg>
  )
}

export function ClaudeHeroRepositoryCapsule({
  branches, selected, worktree, busy, menuOpen, worktreeLabel, searchPlaceholder, emptySearchLabel,
  worktreeLocked = false, onMenuOpenChange, onSelect, onWorktreeChange,
}: {
  branches: readonly string[]
  selected: string
  worktree: boolean
  busy: boolean
  menuOpen: boolean
  worktreeLabel: string
  searchPlaceholder: string
  emptySearchLabel: string
  /** Multi-ticket kickoff always builds worktrees; the toggle locks checked. */
  worktreeLocked?: boolean
  onMenuOpenChange: (open: boolean) => void
  onSelect: (branch: string) => void
  onWorktreeChange: (checked: boolean) => void
}) {
  const pickerRef = useRef<HTMLSpanElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [worktreeHovered, setWorktreeHovered] = useState(false)
  const [worktreeFocused, setWorktreeFocused] = useState(false)
  const ordered = useMemo(() => selectedBranchFirst(branches, selected), [branches, selected])
  const filtered = useMemo(() => filterRepositoryBranches(ordered, query), [ordered, query])

  useEffect(() => {
    if (!menuOpen) {
      setQuery('')
      setActiveIndex(0)
      return
    }
    setActiveIndex(0)
    searchRef.current?.focus()
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && pickerRef.current?.contains(event.target) !== true) onMenuOpenChange(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
    }
  }, [menuOpen, onMenuOpenChange])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (menuOpen) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, menuOpen])

  const chooseActive = (): void => {
    const branch = filtered[activeIndex]
    if (branch !== undefined) onSelect(branch)
  }

  const handleMenuKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const key = event.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
      setActiveIndex(current => branchMenuNavigationIndex(current, filtered.length, key))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      chooseActive()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onMenuOpenChange(false)
    }
  }

  return (
    <span style={styles.heroRepositoryCapsule}>
      <span ref={pickerRef} style={styles.heroBranchPicker}>
        <button
          type="button"
          style={styles.heroBranchTrigger}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busy}
          onClick={() => { onMenuOpenChange(!menuOpen) }}
        >
          <IconBranchOutline16 />
          <span style={styles.heroBranchName}>{selected}</span>
          <IconChevronDownOutline14 />
        </button>
        {menuOpen ? (
          <span role="menu" aria-activedescendant={filtered[activeIndex] === undefined ? undefined : `claude-branch-option-${activeIndex}`} style={styles.heroBranchMenu} onKeyDown={handleMenuKeyDown}>
            <label style={styles.heroBranchSearch}>
              <IconSearchOutline16 />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                style={styles.heroBranchSearchInput}
                onChange={event => { setQuery(event.currentTarget.value) }}
              />
            </label>
            <span style={styles.heroBranchList}>
              {filtered.length === 0 ? <span style={styles.heroBranchEmpty}>{emptySearchLabel}</span> : filtered.map((branch, index) => (
                <button
                  ref={element => { optionRefs.current[index] = element }}
                  id={`claude-branch-option-${index}`}
                  key={branch}
                  type="button"
                  role="menuitem"
                  aria-current={branch === selected ? 'true' : undefined}
                  data-active={index === activeIndex ? 'true' : undefined}
                  style={{ ...styles.heroBranchItem, ...(index === activeIndex ? styles.heroBranchItemActive : {}) }}
                  onMouseEnter={() => { setActiveIndex(index) }}
                  onClick={() => { onSelect(branch) }}
                >
                  <span style={styles.heroBranchItemName}>{branch}</span>
                  {branch === selected ? <IconCheckOutline14 /> : null}
                </button>
              ))}
            </span>
          </span>
        ) : null}
      </span>
      <span aria-hidden="true" style={styles.heroRepositoryDivider} />
      <button
        type="button"
        role="checkbox"
        aria-checked={worktreeLocked || worktree}
        disabled={busy || worktreeLocked}
        style={{
          ...styles.heroWorktreeToggle,
          ...(worktreeLocked || worktree || worktreeHovered ? styles.heroWorktreeToggleActive : {}),
          ...(worktreeFocused ? styles.heroWorktreeToggleFocused : {}),
        }}
        onMouseEnter={() => { setWorktreeHovered(true) }}
        onMouseLeave={() => { setWorktreeHovered(false) }}
        // The focus ring is for keyboard users; click focus lingering after a
        // toggle would otherwise leave a permanent halo around the checkbox.
        onFocus={event => { setWorktreeFocused(event.currentTarget.matches(':focus-visible')) }}
        onBlur={() => { setWorktreeFocused(false) }}
        onClick={() => { onWorktreeChange(!worktree) }}
      >
        <span aria-hidden="true" style={{ ...styles.heroWorktreeCheckbox, ...(worktreeLocked || worktree ? styles.heroWorktreeCheckboxChecked : {}) }}>
          {worktreeLocked || worktree ? (
            <svg viewBox="0 0 12 12" style={styles.heroWorktreeCheckboxIcon}>
              <path d="m2.5 6.2 2.1 2.1 4.9-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
            </svg>
          ) : null}
        </span>
        {worktreeLabel}
      </button>
    </span>
  )
}

export function ClaudeHeroRepositoryControls({
  sessionId, useSessions, useWorkspaces, input, t, prepare, prepareMany,
}: ClaudeHeroRepositoryControlsProps) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const workspacePath = useWorkspaces(state => state.items.find(item => item.sessionIds.includes(sessionId))?.path)
  const [portal, setPortal] = useState<HTMLElement>()
  const [branches, setBranches] = useState<RepositoryBranchList>()
  const [selected, setSelected] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progressStage, setProgressStage] = useState<RepositoryPreparationStage>()
  const [progressError, setProgressError] = useState<string>()
  const [error, setError] = useState<string>()
  const [jiraConnected, setJiraConnected] = useState(false)
  const [tickets, setTickets] = useState<readonly JiraTicket[]>([])
  const [batchProgress, setBatchProgress] = useState<BatchTicketProgress>()
  const [batchDone, setBatchDone] = useState<number>()
  const [ticketMenuOpen, setTicketMenuOpen] = useState(false)
  const [ticketQuery, setTicketQuery] = useState('')
  const [ticketResults, setTicketResults] = useState<readonly JiraTicket[]>()
  const [ticketError, setTicketError] = useState<string>()
  const ticketPickerRef = useRef<HTMLSpanElement>(null)
  const ticketSearchRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef(false)
  const path = workspacePath ?? cwd

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    let scheduled = false
    const reconcile = (): void => {
      scheduled = false
      const target = locateClaudePresetSeat()
      if (target === undefined) {
        removeClaudeHeroPortals()
        setPortal(undefined)
        return
      }
      setPortal(ensureClaudeHeroPortal(target.seat))
    }
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(reconcile)
    }
    reconcile()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-phase'] })
    return () => {
      observer.disconnect()
      removeClaudeHeroPortals()
    }
  }, [sessionId])

  useEffect(() => {
    setBranches(undefined)
    setSelected('')
    setWorktree(false)
    setMenuOpen(false)
    setProgressStage(undefined)
    setProgressError(undefined)
    setError(undefined)
    setTickets([])
    setBatchProgress(undefined)
    setBatchDone(undefined)
    setTicketMenuOpen(false)
    setTicketQuery('')
    setTicketResults(undefined)
    setTicketError(undefined)
    if (portal === undefined || path === undefined) return
    const controller = new AbortController()
    void loadRepositoryBranches(path, controller.signal).then((value) => {
      setBranches(value)
      setSelected(value.current ?? value.branches[0] ?? '')
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { controller.abort() }
  }, [portal, path, sessionId])

  const availableBranches = branches === undefined ? [] : repositoryBranchOptions(branches)
  // A ticket alone routes the submission through prepare: without a worktree it
  // stays on the selected branch, with one it opens a worktree named after the key.
  const changed = branches !== undefined && selected.length > 0 && (worktree || tickets.length > 0 || selected !== branches.current)
  useEffect(() => {
    if (!changed || portal === undefined || busy) return
    const submit = (event: KeyboardEvent | MouseEvent): void => {
      // A ticket seeds the draft itself, so an empty composer may still submit.
      if (pendingRef.current || (input.draft.trim().length === 0 && tickets.length === 0)) return
      const intercept = event instanceof KeyboardEvent ? shouldInterceptKey(event) : shouldInterceptClick(event)
      if (!intercept) return
      event.preventDefault()
      event.stopPropagation()
      pendingRef.current = true
      setBusy(true)
      setProgressError(undefined)
      setError(undefined)
      setBatchDone(undefined)
      if (tickets.length > 1) {
        const total = tickets.length
        setBatchProgress({ ticketKey: tickets[0]?.key ?? '', index: 0, total, stage: 'inspecting' })
        setProgressStage('inspecting')
        void prepareMany(branches.root, selected, tickets, progress => {
          setBatchProgress(progress)
          setProgressStage(progress.stage)
        }).then(() => {
          setBatchDone(total)
          setBatchProgress(undefined)
          setProgressStage(undefined)
          setTickets([])
        }, (reason: unknown) => {
          setProgressError(reason instanceof Error ? reason.message : String(reason))
        }).finally(() => {
          pendingRef.current = false
          setBusy(false)
        })
        return
      }
      const ticket = tickets[0]
      setProgressStage(worktree ? 'inspecting' : undefined)
      void prepare(branches.root, selected, worktree, stage => { if (worktree) setProgressStage(stage) }, ticket).catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (worktree) setProgressError(message)
        else setError(message)
      }).finally(() => {
        pendingRef.current = false
        setBusy(false)
      })
    }
    document.addEventListener('keydown', submit, true)
    document.addEventListener('click', submit, true)
    return () => {
      document.removeEventListener('keydown', submit, true)
      document.removeEventListener('click', submit, true)
    }
  }, [branches, busy, changed, input.draft, portal, prepare, prepareMany, selected, tickets, worktree])

  // The ticket menu only exists once a Jira connection is configured.
  useEffect(() => {
    const controller = new AbortController()
    void loadJiraStatus(controller.signal).then(status => { setJiraConnected(status.connected) }, () => {
      if (!controller.signal.aborted) setJiraConnected(false)
    })
    return () => { controller.abort() }
  }, [sessionId])

  // Ticket search: debounced against the Jira route while the menu is open.
  useEffect(() => {
    if (!ticketMenuOpen) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setTicketError(undefined)
      void searchJiraTickets(ticketQuery, controller.signal).then(setTicketResults, (reason: unknown) => {
        if (controller.signal.aborted) return
        setTicketResults([])
        setTicketError(reason instanceof JiraClientError && reason.code === 'not-connected'
          ? t('heroTicketNotConnected')
          : reason instanceof Error ? reason.message : t('heroTicketFailed'))
      })
    }, ticketQuery.length === 0 ? 0 : 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [t, ticketMenuOpen, ticketQuery])
  useEffect(() => {
    if (!ticketMenuOpen) {
      setTicketQuery('')
      setTicketResults(undefined)
      return
    }
    ticketSearchRef.current?.focus()
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && ticketPickerRef.current?.contains(event.target) !== true) setTicketMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => { document.removeEventListener('pointerdown', closeOnOutsidePointer) }
  }, [ticketMenuOpen])
  // Toggling keeps the menu open so several tickets can be picked in one go.
  const toggleTicket = (next: JiraTicket): void => {
    setTickets(current => toggleTicketSelection(current, next))
    setError(undefined)
    setBatchDone(undefined)
  }
  const clearTickets = (): void => {
    setTickets([])
    setError(undefined)
    setTicketMenuOpen(false)
  }
  if (portal === undefined || path === undefined) return null
  return createPortal((
    <span style={styles.heroRepositoryControls}>
      {branches === undefined ? (
        <span style={styles.heroRepositoryStatus}>{error ?? t('repositoryBranchesLoading')}</span>
      ) : <>
        <ClaudeHeroRepositoryCapsule
          branches={availableBranches}
          selected={selected}
          worktree={worktree}
          busy={busy}
          menuOpen={menuOpen}
          worktreeLabel={t('repositoryWorktree')}
          searchPlaceholder={t('repositoryBranchSearch')}
          emptySearchLabel={t('repositoryBranchSearchEmpty')}
          worktreeLocked={tickets.length > 1}
          onMenuOpenChange={setMenuOpen}
          onSelect={(branch) => {
            setSelected(branch)
            setMenuOpen(false)
            setError(undefined)
          }}
          onWorktreeChange={(checked) => { setWorktree(checked); setError(undefined) }}
        />
        {!jiraConnected ? null : <span style={styles.heroRepositoryCapsule}>
          <span ref={ticketPickerRef} style={styles.heroBranchPicker}>
            <button
              type="button"
              style={styles.heroBranchTrigger}
              aria-expanded={ticketMenuOpen}
              aria-label={t('heroTicketMenu')}
              title={t('heroTicketMenu')}
              disabled={busy}
              onClick={() => { setTicketMenuOpen(!ticketMenuOpen) }}
            >
              <TicketIcon />
              <span style={styles.heroBranchName}>
                {tickets.length === 0 ? t('heroTicket') : tickets.length === 1 ? tickets[0]?.key : t('heroTicketCount', { count: tickets.length })}
              </span>
              <IconChevronDownOutline14 />
            </button>
            {ticketMenuOpen ? (
              <span role="menu" style={{ ...styles.heroBranchMenu, ...styles.heroTicketMenu }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setTicketMenuOpen(false) } }}>
                <label style={styles.heroBranchSearch}>
                  <IconSearchOutline16 />
                  <input
                    ref={ticketSearchRef}
                    type="search"
                    value={ticketQuery}
                    placeholder={t('heroTicketSearch')}
                    aria-label={t('heroTicketSearch')}
                    style={styles.heroBranchSearchInput}
                    onChange={event => { setTicketQuery(event.currentTarget.value) }}
                  />
                </label>
                {tickets.length === 0 ? null : (
                  <span style={styles.heroTicketChips}>
                    {tickets.map(item => (
                      <span key={item.key} style={styles.heroTicketChip}>
                        {item.key}
                        <button
                          type="button"
                          style={styles.heroTicketChipRemove}
                          aria-label={t('heroTicketRemove', { key: item.key })}
                          onClick={() => { toggleTicket(item) }}
                        >×</button>
                      </span>
                    ))}
                    {tickets.length > 1
                      ? <button type="button" style={styles.heroTicketChipsClear} onClick={clearTickets}>{t('heroTicketNone')}</button>
                      : null}
                  </span>
                )}
                <span style={styles.heroBranchList}>
                  {ticketError !== undefined
                    ? <span style={styles.heroBranchEmpty}>{ticketError}</span>
                    : ticketResults === undefined
                      ? <span style={styles.heroBranchEmpty}>{t('heroTicketLoading')}</span>
                      : ticketResults.length === 0 ? <span style={styles.heroBranchEmpty}>{t('heroTicketEmpty')}</span> : ticketResults.map(item => {
                        const picked = tickets.some(entry => entry.key === item.key)
                        return (
                          <button key={item.key} type="button" role="menuitemcheckbox" aria-checked={picked} style={styles.heroBranchItem} onClick={() => { toggleTicket(item) }}>
                            <span aria-hidden="true" style={{ ...styles.heroTicketCheckbox, ...(picked ? styles.heroWorktreeCheckboxChecked : {}) }}>
                              {picked ? (
                                <svg viewBox="0 0 12 12" style={styles.heroWorktreeCheckboxIcon}>
                                  <path d="m2.5 6.2 2.1 2.1 4.9-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                                </svg>
                              ) : null}
                            </span>
                            <span style={styles.heroTicketKey}>{item.key}</span>
                            <span style={styles.heroBranchItemName}>{item.summary}</span>
                            {item.status === undefined ? null : <span style={styles.heroTicketStatus}>{item.status}</span>}
                          </button>
                        )
                      })}
                </span>
              </span>
            ) : null}
          </span>
        </span>}
        {error === undefined ? null : <span role="alert" style={styles.heroRepositoryError}>{error}</span>}
        {batchDone === undefined ? null : <span role="status" style={styles.heroRepositoryStatus}>{t('heroBatchStarted', { count: batchDone })}</span>}
      </>}
      {progressStage === undefined || (!busy && progressError === undefined) ? null : (
        <WorktreeProgressCard
          stage={progressStage}
          {...(progressError === undefined ? {} : { error: progressError })}
          {...(batchProgress === undefined ? {} : { context: `${batchProgress.ticketKey} · ${batchProgress.index + 1}/${batchProgress.total}` })}
          t={t}
          onDismiss={() => { setProgressStage(undefined); setProgressError(undefined); setBatchProgress(undefined) }}
        />
      )}
    </span>
  ), portal)
}
