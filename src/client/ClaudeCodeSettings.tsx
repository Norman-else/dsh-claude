import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CLAUDE_DOCTOR_PATH, CLAUDE_GLOBAL_SETTINGS_PATH, CLAUDE_UPDATE_CHECK_PATH, CLAUDE_UPDATE_PATH } from '../constants.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import * as styles from './styles.ts'

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

export interface GlobalSettingView {
  key: string
  kind: 'select'
  value: string
  options: readonly GlobalSettingOption[]
  effect: 'new-session' | 'restart'
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
    return typeof item.key === 'string'
      && item.kind === 'select'
      && typeof item.value === 'string'
      && ['new-session', 'restart'].includes(String(item.effect))
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

interface GlobalSettingSelectProps {
  setting: GlobalSettingView
  disabled: boolean
  onChange: (value: string) => void
}

export function GlobalSettingSelect({ setting, disabled, onChange }: GlobalSettingSelectProps) {
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
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled || setting.options.length === 0}
        style={{ ...styles.settingSelectTrigger, ...(open ? styles.settingSelectTriggerOpen : {}) }}
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
        <span style={styles.settingSelectValue}>{selectedOption?.label ?? setting.value}</span>
        <span aria-hidden="true" style={{ ...styles.settingSelectChevron, ...(open ? styles.settingSelectChevronOpen : {}) }}>⌄</span>
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
                <span>{option.label}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function ClaudeCodeSettings({ t }: ClaudeCodeSettingsInjected) {
  const [report, setReport] = useState<DoctorReport>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<PluginUpdateStatus>()
  const [updateError, setUpdateError] = useState<string>()
  const [updateBusy, setUpdateBusy] = useState<'check' | 'update'>()
  const [globalSettings, setGlobalSettings] = useState<GlobalSettingsView>()
  const [globalSettingsError, setGlobalSettingsError] = useState<string>()
  const [globalSettingsBusy, setGlobalSettingsBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    setReport(undefined)
    try {
      const response = await fetch(CLAUDE_DOCTOR_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      const payload = await response.json() as DoctorReport | { error?: string }
      if (!response.ok) throw new Error('error' in payload ? payload.error : `HTTP ${response.status}`)
      setReport(payload as DoctorReport)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const requestGlobalSettings = useCallback(async (changes?: Record<string, string>) => {
    setGlobalSettingsBusy(true)
    setGlobalSettingsError(undefined)
    try {
      const response = await fetch(CLAUDE_GLOBAL_SETTINGS_PATH, {
        method: changes === undefined ? 'GET' : 'PATCH',
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(changes === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(changes === undefined ? {} : { body: JSON.stringify({ changes }) }),
      })
      const payload = await response.json() as unknown
      if (!response.ok) {
        const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      if (!isGlobalSettingsView(payload)) throw new Error('Invalid global settings response')
      setGlobalSettings(payload)
    } catch (cause) {
      setGlobalSettingsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGlobalSettingsBusy(false)
    }
  }, [])

  useEffect(() => { void requestGlobalSettings() }, [requestGlobalSettings])

  const requestUpdate = useCallback(async (action: 'check' | 'update') => {
    setUpdateBusy(action)
    setUpdateError(undefined)
    try {
      const response = await fetch(action === 'check' ? CLAUDE_UPDATE_CHECK_PATH : CLAUDE_UPDATE_PATH, {
        method: action === 'check' ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const payload = await response.json() as unknown
      if (!response.ok) {
        const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      if (!isPluginUpdateStatus(payload)) throw new Error('Invalid update response')
      setUpdateStatus(payload)
    } catch (cause) {
      setUpdateError(cause instanceof Error ? cause.message : String(cause))
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
        {error === undefined ? null : <p role="alert" style={{ ...styles.notice, color: 'var(--dsw-alias-state-error-primary)' }}>{t('error')}: {error}</p>}
      </section>

      <section style={styles.settingsCard}>
        <div>
          <h3 style={styles.settingsSectionHeading}>{t('globalSettings')}</h3>
          <p style={styles.settingsBody}>{t('globalSettingsBody')}</p>
        </div>
        {globalSettings === undefined ? <p style={styles.notice}>{t('globalSettingsLoading')}</p> : globalSettings.settings.map(setting => (
          <div key={setting.key} style={styles.diagnosticGrid}>
            <span style={styles.diagnosticLabel}>{setting.key === 'outputStyle' ? t('outputStyle') : setting.key}</span>
            <GlobalSettingSelect
              setting={setting}
              disabled={globalSettingsBusy}
              onChange={nextValue => { void requestGlobalSettings({ [setting.key]: nextValue }) }}
            />
          </div>
        ))}
        {globalSettings?.settings.some(setting => setting.effect === 'new-session') === true
          ? <p style={styles.notice}>{t('globalSettingsNewSession')}</p>
          : null}
        {globalSettingsError === undefined ? null : <p role="alert" style={{ ...styles.notice, color: 'var(--dsw-alias-state-error-primary)' }}>{t('globalSettingsError')}: {globalSettingsError}</p>}
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
        {updateError === undefined ? null : <p role="alert" style={{ ...styles.notice, color: 'var(--dsw-alias-state-error-primary)' }}>{t('updateError')}: {updateError}</p>}
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
