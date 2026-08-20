import { useCallback, useEffect, useState } from 'react'
import { CLAUDE_DOCTOR_PATH, CLAUDE_UPDATE_CHECK_PATH, CLAUDE_UPDATE_PATH } from '../constants.ts'
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

export interface ClaudeCodeSettingsInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

function value(status: string, detail?: string): string {
  return detail === undefined ? status : `${status} · ${detail}`
}

export function ClaudeCodeSettings({ t }: ClaudeCodeSettingsInjected) {
  const [report, setReport] = useState<DoctorReport>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<PluginUpdateStatus>()
  const [updateError, setUpdateError] = useState<string>()
  const [updateBusy, setUpdateBusy] = useState<'check' | 'update'>()

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
