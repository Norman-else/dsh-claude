import { useCallback, useEffect, useState } from 'react'
import { CLAUDE_DOCTOR_PATH } from '../constants.ts'
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
      <div>
        <h2 style={styles.settingsHeading}>{t('title')}</h2>
        <p style={styles.settingsBody}>{t('description')}</p>
      </div>
      {rows.length === 0 ? null : (
        <div style={styles.diagnosticGrid}>
          {rows.flatMap(([label, rowValue]) => [
            <span key={`${label}-label`} style={styles.diagnosticLabel}>{label}</span>,
            <span key={`${label}-value`} style={styles.diagnosticValue}>{rowValue}</span>,
          ])}
        </div>
      )}
      {error === undefined ? null : <p style={{ ...styles.settingsBody, color: 'var(--dsw-alias-state-error-primary)' }}>{t('error')}: {error}</p>}
      <button type="button" style={styles.button} onClick={() => { void refresh() }} disabled={busy}>
        {busy ? t('refreshing') : t('doctor')}
      </button>
      <div>
        <h3 style={{ ...styles.settingsHeading, fontSize: 15, lineHeight: '22px' }}>{t('security')}</h3>
        <p style={styles.settingsBody}>{t('securityBody')}</p>
      </div>
    </div>
  )
}
