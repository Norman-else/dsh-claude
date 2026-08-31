import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { CLAUDE_DOCTOR_PATH, CLAUDE_GLOBAL_SETTINGS_PATH, CLAUDE_UPDATE_CHECK_PATH, CLAUDE_UPDATE_PATH, CLAUDE_USAGE_PATH } from '../constants.ts'
import type { PlanUsageReport, PlanUsageWindow } from '../plan-usage.ts'
import { DEFAULT_CLAUDE_PROSE_MODE, isClaudeProseMode, type ClaudeProseMode } from '../constants.ts'
import { applyClaudeMarkdownTheme } from './markdown-theme.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import * as styles from './styles.ts'
import { connectJira, disconnectJira, loadJiraStatus, type JiraStatus } from './jira-api.ts'
import { PluginRequestError, pluginRead, pluginWrite } from './plugin-transport.ts'

interface DoctorReport {
  executable: { status: 'found' | 'missing'; path?: string; searched: readonly string[] }
  version: { status: 'ok' | 'error' | 'not-run'; value?: string; message?: string }
  authentication: { status: 'signed-in' | 'signed-out' | 'unknown' | 'not-run'; method?: string; provider?: string; subscription?: string; message?: string }
  handshake: 'not-run' | 'ok' | 'error'
  limits: { idleTimeoutMs: number; maxProcesses: number }
  processes: { count: number; active: number }
}

export interface PluginUpdateStatus {
  currentVersion: string
  latestVersion?: string
  source: 'registry' | 'link' | 'unsupported' | 'unknown'
  state: 'current' | 'available' | 'linked' | 'unsupported' | 'unavailable' | 'error'
  canUpdate: boolean
  restartRequired: boolean
  message?: string
}

export function isPluginUpdateStatus(value: unknown): value is PluginUpdateStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  return typeof status.currentVersion === 'string'
    && (status.latestVersion === undefined || typeof status.latestVersion === 'string')
    && ['registry', 'link', 'unsupported', 'unknown'].includes(String(status.source))
    && ['current', 'available', 'linked', 'unsupported', 'unavailable', 'error'].includes(String(status.state))
    && typeof status.canUpdate === 'boolean'
    && typeof status.restartRequired === 'boolean'
    && (status.message === undefined || typeof status.message === 'string')
}

export interface GlobalSettingOption {
  value: string
  label: string
  source: 'built-in' | 'user' | 'configured'
}

export type GlobalSettingView = {
  key: string
  kind: 'select'
  value: string
  options: readonly GlobalSettingOption[]
  effect: 'immediate' | 'new-session' | 'next-turn' | 'next-worktree' | 'restart'
} | {
  key: string
  kind: 'text'
  value: string
  maxLength: number
  effect: 'immediate' | 'new-session' | 'next-turn' | 'next-worktree' | 'restart'
}

interface GlobalSettingsView {
  settings: readonly GlobalSettingView[]
}

export function isGlobalSettingsView(value: unknown): value is GlobalSettingsView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const settings = (value as { settings?: unknown }).settings
  return Array.isArray(settings) && settings.every(setting => {
    if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) return false
    const item = setting as Record<string, unknown>
    if (typeof item.key !== 'string'
      || typeof item.value !== 'string'
      || !['immediate', 'new-session', 'next-turn', 'next-worktree', 'restart'].includes(String(item.effect))) return false
    if (item.kind === 'text') return typeof item.maxLength === 'number' && item.maxLength > 0
    return item.kind === 'select'
      && Array.isArray(item.options)
      && item.options.every(option => typeof option === 'object' && option !== null
        && typeof (option as Record<string, unknown>).value === 'string'
        && typeof (option as Record<string, unknown>).label === 'string'
        && ['built-in', 'user', 'configured'].includes(String((option as Record<string, unknown>).source)))
  })
}

export interface ClaudeCodeSettingsInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

function value(status: string, detail?: string): string {
  return detail === undefined ? status : `${status} · ${detail}`
}

/** The trigger's disclosure chevron.
 *
 *  Geometry rather than a character: the ink spans y 6 to 10 in a 16-unit box,
 *  so it is centred on the box's own centre and the open state's 180-degree
 *  flip lands exactly where the closed state sat. A text arrowhead carries its
 *  ink below the centre of the em box, which is why this needed a hand-tuned
 *  nudge that could only be right in one of the two states. */
function SelectChevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

interface GlobalSettingSelectProps {
  setting: Extract<GlobalSettingView, { kind: 'select' }>
  disabled: boolean
  onChange: (value: string) => void
  /** Display text for one option. Server-discovered names (output styles) are
   *  shown verbatim; a fixed vocabulary the plugin owns is translated. */
  labelFor?: (option: GlobalSettingOption) => string
}

export function GlobalSettingText({ setting, disabled, onChange }: {
  setting: Extract<GlobalSettingView, { kind: 'text' }>
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState(setting.value)
  useEffect(() => { setDraft(setting.value) }, [setting.value])
  const save = (): void => {
    if (draft !== setting.value) onChange(draft)
  }
  return (
    <input
      type="text"
      value={draft}
      maxLength={setting.maxLength}
      disabled={disabled}
      style={styles.settingTextInput}
      onChange={event => { setDraft(event.currentTarget.value) }}
      onBlur={save}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          save()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          setDraft(setting.value)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function GlobalSettingSelect({ setting, disabled, onChange, labelFor = option => option.label }: GlobalSettingSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const selectedIndex = Math.max(0, setting.options.findIndex(option => option.value === setting.value))
  const selectedOption = setting.options[selectedIndex]

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsidePointer)
    return () => document.removeEventListener('mousedown', closeOnOutsidePointer)
  }, [open])

  const openMenu = (index = selectedIndex): void => {
    setActiveIndex(index)
    setOpen(true)
  }

  const choose = (index: number): void => {
    const option = setting.options[index]
    if (option === undefined) return
    setOpen(false)
    triggerRef.current?.focus()
    if (option.value !== setting.value) onChange(option.value)
  }

  const move = (offset: number): void => {
    const count = setting.options.length
    if (count === 0) return
    setActiveIndex(current => (current + offset + count) % count)
  }

  return (
    <div
      ref={rootRef}
      style={styles.settingSelect}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <style data-dsh-claude-setting-select-styles>{styles.settingSelectCss}</style>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled || setting.options.length === 0}
        className={styles.settingSelectTriggerClass}
        onClick={() => { if (open) setOpen(false); else openMenu() }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) openMenu(event.key === 'ArrowDown' ? selectedIndex : Math.max(0, setting.options.length - 1))
            else move(event.key === 'ArrowDown' ? 1 : -1)
          } else if (event.key === 'Home' && open) {
            event.preventDefault()
            setActiveIndex(0)
          } else if (event.key === 'End' && open) {
            event.preventDefault()
            setActiveIndex(Math.max(0, setting.options.length - 1))
          } else if ((event.key === 'Enter' || event.key === ' ') && open) {
            event.preventDefault()
            choose(activeIndex)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            setOpen(false)
          }
        }}
      >
        <span style={styles.settingSelectValue}>{selectedOption === undefined ? setting.value : labelFor(selectedOption)}</span>
        <span aria-hidden="true" className={styles.settingSelectChevronClass}><SelectChevron /></span>
      </button>
      {open ? (
        <div id={listboxId} role="listbox" aria-activedescendant={`${listboxId}-${activeIndex}`} style={styles.settingSelectMenu}>
          {setting.options.map((option, index) => {
            const selected = option.value === setting.value
            const active = index === activeIndex
            return (
              <button
                id={`${listboxId}-${index}`}
                key={`${option.source}:${option.value}`}
                type="button"
                role="option"
                aria-selected={selected}
                style={{ ...styles.settingSelectOption, ...(active ? styles.settingSelectOptionActive : {}) }}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={event => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span style={styles.settingSelectCheck} aria-hidden="true">{selected ? '✓' : ''}</span>
                <span>{labelFor(option)}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** Fixed windows carry a translated label; server-named model buckets (e.g.
 *  'Fable') arrive with their own `label` and are shown verbatim. */
const TRANSLATED_WINDOWS = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'])

/** The prose mode a settings payload carries, or the default when it carries
 *  none — an older Host, or a response this Client does not fully understand,
 *  leaves the palette alone rather than guessing. */
export function proseModeOf(settings: readonly GlobalSettingView[]): ClaudeProseMode {
  const value = settings.find(setting => setting.key === 'prose')?.value
  return isClaudeProseMode(value) ? value : DEFAULT_CLAUDE_PROSE_MODE
}

/** Settings whose row only makes sense under a particular value of another.
 *  Filtering here rather than server-side keeps the descriptor list flat: the
 *  server has no view of what the Client can paint. Fails OPEN — a payload
 *  missing the setting a row depends on shows the row rather than hiding it,
 *  so an older Host cannot make a setting unreachable. */
export function visibleGlobalSettings(settings: readonly GlobalSettingView[]): readonly GlobalSettingView[] {
  // The prose palette is a stylesheet over markup this package renders; under
  // the native renderer the Host draws the turn and the rules never match.
  const renderer = settings.find(setting => setting.key === 'renderer')
  if (renderer === undefined || renderer.value !== 'native') return settings
  return settings.filter(setting => setting.key !== 'prose')
}

/** Per-setting label and the effect note that used to sit as a standalone
 *  paragraph under the card; it now hangs off the label as a hover hint. */
export const SETTING_COPY: Readonly<Record<string, { label: ClaudeCodeSettingsKey; hint: ClaudeCodeSettingsKey }>> = {
  outputStyle: { label: 'outputStyle', hint: 'globalSettingsNewSession' },
  renderer: { label: 'renderer', hint: 'rendererEffect' },
  prose: { label: 'prose', hint: 'proseEffect' },
  worktreeBranchPrefix: { label: 'worktreeBranchPrefix', hint: 'worktreeBranchPrefixEffect' },
  maxProcesses: { label: 'maxProcessesSetting', hint: 'maxProcessesEffect' },
  idleTimeoutMinutes: { label: 'idleTimeoutSetting', hint: 'idleTimeoutEffect' },
}

/** Translated display text for the option vocabularies this plugin owns,
 *  keyed `<setting>:<option>`. Options discovered on the machine (output style
 *  names) carry no entry and keep the label the route reported. */
export const SETTING_OPTION_COPY: Readonly<Record<string, ClaudeCodeSettingsKey>> = {
  'renderer:plugin': 'rendererPlugin',
  'renderer:native': 'rendererNative',
  'prose:plain': 'prosePlain',
  'prose:enhanced': 'proseEnhanced',
}

export function settingOptionLabel(
  settingKey: string,
  option: GlobalSettingOption,
  t: ClaudeCodeSettingsInjected['t'],
): string {
  const key = SETTING_OPTION_COPY[`${settingKey}:${option.value}`]
  return key === undefined ? option.label : t(key)
}

/** '?' badge that reveals a setting's effect note on hover or keyboard focus. */
export function SettingHint({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip label={text} side="top" delayMs={150} maxWidth={320}>
      <span role="note" tabIndex={0} aria-label={`${label}: ${text}`} style={styles.settingHint}>?</span>
    </Tooltip>
  )
}

export function isPlanUsageReport(value: unknown): value is PlanUsageReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const report = value as Record<string, unknown>
  return typeof report.available === 'boolean'
    && typeof report.fetchedAt === 'number'
    && Array.isArray(report.windows)
    && report.windows.every(entry => typeof entry === 'object' && entry !== null
      && typeof (entry as Record<string, unknown>).id === 'string')
}

/** Coarse duration for a reset countdown or the age of a reading: minutes
 *  below an hour, then hours, then days. Never negative — a passed reset
 *  reads '0m'. */
export function durationLabel(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d`
}

export function PlanUsageMeter({ window: usageWindow, t, now }: {
  window: PlanUsageWindow
  t: ClaudeCodeSettingsInjected['t']
  now: number
}) {
  const used = usageWindow.utilization
  const tone = styles.planUsageTone(used)
  const resetsIn = usageWindow.resetsAt === undefined ? undefined : Date.parse(usageWindow.resetsAt)
  return (
    <span style={styles.planUsageMeter}>
      <span style={styles.planUsageTrack}>
        <span style={{ ...styles.planUsageFill, width: `${used ?? 0}%`, background: tone.fill }} />
      </span>
      <span style={{ ...styles.planUsageMeta, color: tone.text }}>
        {used === undefined ? '—' : t('planUsageUsed', { percent: Math.round(used) })}
        {resetsIn === undefined || !Number.isFinite(resetsIn) ? null : ` · ${t('planUsageResets', { age: durationLabel(resetsIn - now) })}`}
      </span>
    </span>
  )
}

/**
 * These four cards are the ones that fail together when the connection pool
 * saturates, so the failure line has to say which kind of failure this was.
 * `starved` means the plugin is holding every connection it may hold and this
 * read never left the browser — a transient local condition the user can retry,
 * which is why it carries the meter's pressure tone rather than the error tone.
 * Every other reason is a Host that answered badly or not at all.
 *
 * The detail stays the failing route's own sentence, exactly as before; this
 * branch fixes a fault and ships no new user-facing copy.
 */
interface CardFailure {
  detail: string
  starved: boolean
}

function cardFailure(cause: unknown): CardFailure {
  return {
    detail: cause instanceof Error ? cause.message : String(cause),
    starved: cause instanceof PluginRequestError && cause.reason === 'starved',
  }
}

function FailureNotice({ label, failure }: { label: string; failure: CardFailure }) {
  return (
    <p
      role="alert"
      style={{
        ...styles.notice,
        color: failure.starved ? 'var(--dsw-alias-state-warning-primary, #d69e2e)' : 'var(--dsw-alias-state-error-primary)',
      }}
    >{label}: {failure.detail}</p>
  )
}

/** The plan usage report. A plain read serves the cached reading from memory;
 *  the refresh spawns a probe process, which is why only it pays the remote
 *  budget. */
export async function loadPlanUsage(refresh: boolean): Promise<PlanUsageReport> {
  const payload = refresh
    ? await pluginWrite(CLAUDE_USAGE_PATH, 'remote')
    : await pluginRead(CLAUDE_USAGE_PATH, 'fast')
  if (!isPlanUsageReport(payload)) throw new Error('Invalid plan usage response')
  return payload
}

export function PlanUsageCard({ t, load }: {
  t: ClaudeCodeSettingsInjected['t']
  load: (refresh: boolean) => Promise<PlanUsageReport>
}) {
  const [report, setReport] = useState<PlanUsageReport>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CardFailure>()

  const request = useCallback(async (refresh: boolean) => {
    setBusy(true)
    setError(undefined)
    try {
      setReport(await load(refresh))
    } catch (cause) {
      setError(cardFailure(cause))
    } finally {
      setBusy(false)
    }
  }, [load])

  useEffect(() => { void request(false) }, [request])

  // Countdowns are read at render time; the report's own timestamp is enough
  // of a clock because a stale reading is labelled with its own age.
  const now = Date.now()
  return (
    <section style={styles.settingsCard}>
      <div style={styles.settingsCardHeader}>
        <div>
          <h3 style={styles.settingsSectionHeading}>{t('planUsage')}</h3>
          <p style={styles.settingsBody}>{t('planUsageBody')}</p>
        </div>
        <button type="button" style={styles.button} disabled={busy} onClick={() => { void request(true) }}>
          {busy ? t('planUsageRefreshing') : t('planUsageRefresh')}
        </button>
      </div>
      {report === undefined
        ? <p style={styles.notice}>{busy ? t('planUsageLoading') : t('planUsageNever')}</p>
        : report.windows.length === 0
          ? <p style={styles.notice}>{report.fetchedAt === 0 ? t('planUsageNever') : t('planUsageUnavailable')}</p>
          : (
            <div style={styles.diagnosticGrid}>
              {report.subscription === undefined ? null : <>
                <span style={styles.diagnosticLabel}>{t('planUsageSubscription')}</span>
                <span style={styles.diagnosticValue}>{report.subscription}</span>
              </>}
              {report.windows.flatMap(usageWindow => [
                <span key={`${usageWindow.id}-label`} style={styles.diagnosticLabel}>
                  {usageWindow.label ?? (TRANSLATED_WINDOWS.has(usageWindow.id)
                    ? t(`planWindow_${usageWindow.id}` as ClaudeCodeSettingsKey)
                    : usageWindow.id)}
                </span>,
                <PlanUsageMeter key={`${usageWindow.id}-meter`} window={usageWindow} t={t} now={now} />,
              ])}
            </div>
          )}
      {report !== undefined && report.fetchedAt > 0
        ? <p style={styles.notice}>{t('planUsageUpdated', { age: durationLabel(now - report.fetchedAt) })}</p>
        : null}
      {error === undefined ? null : <FailureNotice label={t('planUsageError')} failure={error} />}
    </section>
  )
}

export function ClaudeCodeSettings({ t }: ClaudeCodeSettingsInjected) {
  const [report, setReport] = useState<DoctorReport>()
  const [error, setError] = useState<CardFailure>()
  const [busy, setBusy] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<PluginUpdateStatus>()
  const [updateError, setUpdateError] = useState<CardFailure>()
  const [updateBusy, setUpdateBusy] = useState<'check' | 'update'>()
  const [globalSettings, setGlobalSettings] = useState<GlobalSettingsView>()
  const [globalSettingsError, setGlobalSettingsError] = useState<CardFailure>()
  const [globalSettingsBusy, setGlobalSettingsBusy] = useState(false)
  const [jiraStatus, setJiraStatus] = useState<JiraStatus>()
  const [jiraError, setJiraError] = useState<CardFailure>()
  const [jiraBusy, setJiraBusy] = useState(false)
  const [jiraSite, setJiraSite] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  const [jiraToken, setJiraToken] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void loadJiraStatus(controller.signal).then(setJiraStatus, (reason: unknown) => {
      if (!controller.signal.aborted) setJiraError(cardFailure(reason))
    })
    return () => { controller.abort() }
  }, [])
  const connectJiraNow = async (): Promise<void> => {
    setJiraBusy(true)
    setJiraError(undefined)
    try {
      setJiraStatus(await connectJira({ siteUrl: jiraSite, email: jiraEmail, apiToken: jiraToken }))
      setJiraToken('')
    } catch (cause) {
      setJiraError(cardFailure(cause))
    } finally {
      setJiraBusy(false)
    }
  }
  const disconnectJiraNow = async (): Promise<void> => {
    setJiraBusy(true)
    setJiraError(undefined)
    try {
      await disconnectJira()
      setJiraStatus({ connected: false })
    } catch (cause) {
      setJiraError(cardFailure(cause))
    } finally {
      setJiraBusy(false)
    }
  }

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    setReport(undefined)
    try {
      setReport(await pluginRead<DoctorReport>(CLAUDE_DOCTOR_PATH, 'fast'))
    } catch (cause) {
      setError(cardFailure(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const requestGlobalSettings = useCallback(async (changes?: Record<string, string>) => {
    setGlobalSettingsBusy(true)
    setGlobalSettingsError(undefined)
    try {
      const payload = changes === undefined
        ? await pluginRead(CLAUDE_GLOBAL_SETTINGS_PATH, 'fast')
        : await pluginWrite(CLAUDE_GLOBAL_SETTINGS_PATH, 'fast', undefined, { method: 'PATCH', json: { changes } })
      if (!isGlobalSettingsView(payload)) throw new Error('Invalid global settings response')
      setGlobalSettings(payload)
      // Presentation-only, so it lands by rewriting one global sheet rather
      // than by threading a value down to every Markdown block. Covers the
      // initial read as well as the write, so opening the panel re-syncs a
      // stylesheet that boot could not reach.
      applyClaudeMarkdownTheme(proseModeOf(payload.settings))
    } catch (cause) {
      setGlobalSettingsError(cardFailure(cause))
    } finally {
      setGlobalSettingsBusy(false)
    }
  }, [])

  useEffect(() => { void requestGlobalSettings() }, [requestGlobalSettings])

  const requestUpdate = useCallback(async (action: 'check' | 'update') => {
    setUpdateBusy(action)
    setUpdateError(undefined)
    try {
      const payload = action === 'check'
        ? await pluginRead(CLAUDE_UPDATE_CHECK_PATH, 'remote')
        : await pluginWrite(CLAUDE_UPDATE_PATH, 'remote')
      if (!isPluginUpdateStatus(payload)) throw new Error('Invalid update response')
      setUpdateStatus(payload)
    } catch (cause) {
      setUpdateError(cardFailure(cause))
    } finally {
      setUpdateBusy(undefined)
    }
  }, [])

  const rows = report === undefined ? [] : [
    [t('executable'), report.executable.status === 'found' ? report.executable.path ?? t('unknown') : `${t('missing')} · ${report.executable.searched.join(', ')}`],
    [t('version'), value(report.version.status, report.version.value ?? report.version.message)],
    [t('authentication'), value(report.authentication.status, [report.authentication.method, report.authentication.subscription].filter(Boolean).join(' · ') || report.authentication.message)],
    [t('handshake'), report.handshake],
    [t('processes'), t('processSummary', { total: report.processes.count, active: report.processes.active })],
    [t('limits'), t('limitSummary', { max: report.limits.maxProcesses, minutes: Math.round(report.limits.idleTimeoutMs / 60_000) })],
  ]

  return (
    <div style={styles.settingsPage}>
      <header style={styles.settingsHero}>
        <div style={styles.settingsMark} aria-hidden="true">C</div>
        <div>
          <h2 style={styles.settingsHeading}>{t('title')}</h2>
          <p style={styles.settingsBody}>{t('description')}</p>
        </div>
      </header>

      <section style={styles.settingsCard}>
        <div style={styles.settingsCardHeader}>
          <div>
            <h3 style={styles.settingsSectionHeading}>{t('diagnostics')}</h3>
            <p style={styles.settingsBody}>{t('diagnosticsBody')}</p>
          </div>
          <button type="button" style={styles.button} onClick={() => { void refresh() }} disabled={busy}>
            {busy ? t('refreshing') : t('doctor')}
          </button>
        </div>
        {rows.length === 0 ? <p style={styles.notice}>{t('diagnosticsLoading')}</p> : (
          <div style={styles.diagnosticGrid}>
            {rows.flatMap(([label, rowValue]) => [
              <span key={`${label}-label`} style={styles.diagnosticLabel}>{label}</span>,
              <span key={`${label}-value`} style={styles.diagnosticValue}>{rowValue}</span>,
            ])}
          </div>
        )}
        {error === undefined ? null : <FailureNotice label={t('error')} failure={error} />}
      </section>

      <PlanUsageCard t={t} load={loadPlanUsage} />

      <section style={styles.settingsCard}>
        <div>
          <h3 style={styles.settingsSectionHeading}>{t('globalSettings')}</h3>
          <p style={styles.settingsBody}>{t('globalSettingsBody')}</p>
        </div>
        {globalSettings === undefined ? <p style={styles.notice}>{t('globalSettingsLoading')}</p> : visibleGlobalSettings(globalSettings.settings).map(setting => {
          const copy = SETTING_COPY[setting.key]
          return (
          <div key={setting.key} style={styles.diagnosticGrid}>
            <span style={styles.diagnosticLabel}>
              {copy === undefined ? setting.key : t(copy.label)}
              {copy === undefined ? null : <SettingHint text={t(copy.hint)} label={t('settingHint')} />}
            </span>
            {setting.kind === 'select' ? (
              <GlobalSettingSelect
                setting={setting}
                disabled={globalSettingsBusy}
                labelFor={option => settingOptionLabel(setting.key, option, t)}
                onChange={nextValue => { void requestGlobalSettings({ [setting.key]: nextValue }) }}
              />
            ) : (
              <GlobalSettingText
                setting={setting}
                disabled={globalSettingsBusy}
                onChange={nextValue => { void requestGlobalSettings({ [setting.key]: nextValue }) }}
              />
            )}
          </div>
          )
        })}
        {globalSettingsError === undefined ? null : <FailureNotice label={t('globalSettingsError')} failure={globalSettingsError} />}
      </section>

      <section style={styles.settingsCard}>
        <div style={styles.settingsCardHeader}>
          <div>
            <h3 style={styles.settingsSectionHeading}>{t('jiraTitle')}</h3>
            <p style={styles.settingsBody}>{t('jiraBody')}</p>
          </div>
          {jiraStatus?.connected === true
            ? <button type="button" style={styles.button} disabled={jiraBusy} onClick={() => { void disconnectJiraNow() }}>{t('jiraDisconnect')}</button>
            : null}
        </div>
        {jiraStatus === undefined && jiraError === undefined ? <p style={styles.notice}>{t('jiraLoading')}</p> : null}
        {jiraStatus?.connected === true ? (
          <div style={styles.diagnosticGrid}>
            <span style={styles.diagnosticLabel}>{t('jiraConnected')}</span>
            <span>{jiraStatus.siteUrl} · {jiraStatus.displayName ?? jiraStatus.email}</span>
          </div>
        ) : jiraStatus === undefined ? null : <>
          <div style={styles.diagnosticGrid}>
            <span style={styles.diagnosticLabel}>{t('jiraSite')}</span>
            <input type="url" value={jiraSite} placeholder={t('jiraSitePlaceholder')} disabled={jiraBusy} style={styles.settingTextInput} onChange={event => { setJiraSite(event.currentTarget.value) }} />
          </div>
          <div style={styles.diagnosticGrid}>
            <span style={styles.diagnosticLabel}>{t('jiraEmail')}</span>
            <input type="email" value={jiraEmail} disabled={jiraBusy} style={styles.settingTextInput} onChange={event => { setJiraEmail(event.currentTarget.value) }} />
          </div>
          <div style={styles.diagnosticGrid}>
            <span style={styles.diagnosticLabel}>{t('jiraToken')}</span>
            <input type="password" value={jiraToken} disabled={jiraBusy} autoComplete="off" style={styles.settingTextInput} onChange={event => { setJiraToken(event.currentTarget.value) }} />
          </div>
          <div style={styles.settingsActions}>
            <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" style={styles.settingsLink}>{t('jiraTokenHelp')}</a>
            <button
              type="button"
              style={styles.primaryButton}
              disabled={jiraBusy || jiraSite.trim() === '' || jiraEmail.trim() === '' || jiraToken.trim() === ''}
              onClick={() => { void connectJiraNow() }}
            >{jiraBusy ? t('jiraConnecting') : t('jiraConnect')}</button>
          </div>
        </>}
        {jiraError === undefined ? null : <FailureNotice label={t('jiraError')} failure={jiraError} />}
      </section>

      <section style={styles.settingsCard}>
        <div>
          <h3 style={styles.settingsSectionHeading}>{t('pluginUpdate')}</h3>
          <p style={styles.settingsBody}>{t('pluginUpdateBody')}</p>
        </div>
        {updateStatus === undefined ? <p style={styles.notice}>{t('updateNotChecked')}</p> : (
          <div style={styles.diagnosticGrid}>
            <span style={styles.diagnosticLabel}>{t('installedVersion')}</span>
            <span style={styles.diagnosticValue}>{updateStatus.currentVersion}</span>
            <span style={styles.diagnosticLabel}>{t('installSource')}</span>
            <span style={styles.diagnosticValue}>{t(`updateSource_${updateStatus.source}`)}</span>
            <span style={styles.diagnosticLabel}>{t('updateStatus')}</span>
            <span style={styles.diagnosticValue}>{t(`updateState_${updateStatus.state}`)}</span>
            {updateStatus.latestVersion === undefined ? null : <>
              <span style={styles.diagnosticLabel}>{t('latestVersion')}</span>
              <span style={styles.diagnosticValue}>{updateStatus.latestVersion}</span>
            </>}
          </div>
        )}
        {updateStatus?.message === undefined ? null : <p style={styles.notice}>{updateStatus.message}</p>}
        {updateStatus?.restartRequired !== true ? null : <p style={styles.notice}>{t('restartRequired')}</p>}
        {updateError === undefined ? null : <FailureNotice label={t('updateError')} failure={updateError} />}
        <div style={styles.settingsActions}>
          <button type="button" style={styles.button} onClick={() => { void requestUpdate('check') }} disabled={updateBusy !== undefined}>
            {updateBusy === 'check' ? t('checkingUpdates') : t('checkUpdates')}
          </button>
          <button type="button" style={styles.primaryButton} onClick={() => { void requestUpdate('update') }} disabled={updateBusy !== undefined || updateStatus?.canUpdate !== true}>
            {updateBusy === 'update' ? t('updatingPlugin') : t('updatePlugin')}
          </button>
        </div>
      </section>

      <section style={styles.settingsCard}>
        <h3 style={styles.settingsSectionHeading}>{t('security')}</h3>
        <p style={styles.settingsBody}>{t('securityBody')}</p>
      </section>
    </div>
  )
}
