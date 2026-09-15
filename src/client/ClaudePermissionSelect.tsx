import { useEffect, useState, type ReactNode } from 'react'
import { Menu, RiskConfirmation, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from '../permission-mode.ts'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudePermissionModeOutcome } from './permission-mode-api.ts'
import * as styles from './styles.ts'

export interface ClaudePermissionSelectInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Make `mode` the session's mode from its next turn; see permission-mode-api.ts. */
  setMode: (mode: ClaudePermissionMode) => Promise<ClaudePermissionModeOutcome>
  notify?: (level: 'info' | 'error', text: string) => void
}

export interface ClaudePermissionSelectProps extends ClaudePermissionSelectInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  /** Standard session-scoped hook; `running` is the Host's own turn lock.
   *  Optional so a Host that stops handing it to this slot leaves the
   *  projection's lock in charge instead of crashing the entry. */
  useSession?: SnapshotSelectorHook<{ readonly running: boolean }>
}

const NAME_KEY: Readonly<Record<ClaudePermissionMode, ClaudeCodeSettingsKey>> = {
  plan: 'permissionModePlan',
  default: 'permissionModeDefault',
  acceptEdits: 'permissionModeAcceptEdits',
  dontAsk: 'permissionModeDontAsk',
  auto: 'permissionModeAuto',
  bypassPermissions: 'permissionModeBypass',
}

const HINT_KEY: Readonly<Record<ClaudePermissionMode, ClaudeCodeSettingsKey>> = {
  plan: 'permissionModePlanHint',
  default: 'permissionModeDefaultHint',
  acceptEdits: 'permissionModeAcceptEditsHint',
  dontAsk: 'permissionModeDontAskHint',
  auto: 'permissionModeAutoHint',
  bypassPermissions: 'permissionModeBypassHint',
}

/** One 16px outline glyph per mode, drawn to the Host's own icon grammar
 *  (1.5px round strokes on currentColor) so the row reads as one set with
 *  the attach and plan controls beside it. */
export function ClaudePermissionModeGlyph({ mode }: { mode: ClaudePermissionMode }): ReactNode {
  const paths: Readonly<Record<ClaudePermissionMode, readonly string[]>> = {
    // A clipboard: the plan is written down before anything runs.
    plan: ['M6 2.75h4', 'M4.5 3.75h7a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1z', 'M6 8h4', 'M6 10.5h2.5'],
    // A shield: every action checked.
    default: ['M8 2.25l5 1.9v3.6c0 3.05-2.15 5.15-5 6.25-2.85-1.1-5-3.2-5-6.25v-3.6l5-1.9z', 'M8 6v3', 'M8 11h.01'],
    // A pencil with a check: edits go through on their own.
    acceptEdits: ['M10.4 3.1l2.5 2.5L6.5 12H4v-2.5l6.4-6.4z', 'M9 4.5l2.5 2.5', 'M9.5 13.25l1.5 1.5 3-3'],
    // A bell struck through: nothing is asked.
    dontAsk: ['M5.25 9.5V7.25a2.75 2.75 0 0 1 5.5 0V9.5l1 1.75h-7.5l1-1.75z', 'M6.75 12.75a1.25 1.25 0 0 0 2.5 0', 'M3 3l10 10'],
    // A spark: the classifier decides.
    auto: ['M8 2.5l1.4 3.6 3.6 1.4-3.6 1.4L8 12.5 6.6 8.9 3 7.5l3.6-1.4L8 2.5z', 'M12.5 11.5l.5 1.25 1.25.5-1.25.5-.5 1.25-.5-1.25-1.25-.5 1.25-.5.5-1.25z'],
    // An open padlock.
    bypassPermissions: ['M5 8V6.25a3 3 0 0 1 5.85-.95', 'M4.25 8h7.5v5.5h-7.5z', 'M8 10.25v1.5'],
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {paths[mode].map(d => <path key={d} d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
  )
}

/**
 * Claude Code's own permission modes as the session's access control, in the
 * composer's tool row where the Host's three-mode selector sits for other
 * agent presets. That selector is hidden for Claude sessions (host-chrome.ts)
 * rather than replaced: it is not a slot. This one drives the same Host
 * knobs through the plugin's route, so approvals and the sandbox follow.
 *
 * The pick is shown the moment it is made and held until the projection
 * confirms it; a refused pick drops back to what the projection says.
 */
export function ClaudePermissionSelect({ t, setMode, notify, useClaudeProjection, useSession }: ClaudePermissionSelectProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const view = useClaudeProjection(projection => projection.permissionMode)
  // A prop that is absent stays absent for the component's life, so the hook
  // count is the same on every render.
  const running = useSession === undefined ? false : useSession(session => session.running)
  const [pick, setPick] = useState<ClaudePermissionMode | null>(null)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<ClaudePermissionMode | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const reported = view?.mode
  useEffect(() => {
    if (pick !== null && reported === pick) setPick(null)
  }, [pick, reported])
  if (!owned) return null
  const current = pick ?? reported
  const locked = running || view?.locked === true
  const label = current === undefined ? t('permissionMode') : t(NAME_KEY[current])
  const hint = locked ? t('permissionModeLocked') : current === undefined ? t('permissionMode') : t(HINT_KEY[current])
  const autoUnsupported = view?.autoSupported === false
  const hintOf = (mode: ClaudePermissionMode): string => (mode === 'auto' && autoUnsupported ? t('permissionModeAutoUnsupported') : t(HINT_KEY[mode]))

  const submit = (mode: ClaudePermissionMode): void => {
    setPick(mode)
    setBusy(true)
    setMode(mode).then(outcome => {
      if (!outcome.hostSynced) notify?.('info', t('permissionModeHostKept'))
    }, (error: unknown) => {
      setPick(null)
      notify?.('error', t('permissionModeFailed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { setBusy(false) })
  }
  const choose = (id: string): void => {
    setOpen(false)
    if (id === current || !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(id)) return
    const mode = id as ClaudePermissionMode
    if (mode === 'bypassPermissions') {
      setAcknowledged(false)
      setConfirming(mode)
      return
    }
    submit(mode)
  }
  const closeConfirmation = (): void => {
    setAcknowledged(false)
    setConfirming(null)
  }

  return (
    <span className={styles.permissionSelectClass}>
      <style data-dsh-claude-permission-select-styles>{styles.permissionSelectCss}{styles.permissionSelectRowCss}</style>
      <Menu
        open={open}
        items={CLAUDE_PERMISSION_MODES.map(mode => ({
          id: mode,
          // The description rides under the name rather than in a native
          // title: the Host draws no native tooltips anywhere, and a row
          // that explains itself needs no hover.
          label: (
            <span className={styles.permissionSelectRowClass}>
              <span className={styles.permissionSelectRowNameClass}>{t(NAME_KEY[mode])}</span>
              <span className={styles.permissionSelectRowHintClass}>{hintOf(mode)}</span>
            </span>
          ),
          icon: <ClaudePermissionModeGlyph mode={mode} />,
          ...(mode === 'auto' && autoUnsupported ? { disabled: true } : {}),
          ...(mode === 'bypassPermissions' ? { danger: true } : {}),
        }))}
        selectedId={current}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        anchor={
          <Tooltip label={hint} side="top" delayMs={250} disabled={open}>
            <button
              type="button"
              className={styles.permissionSelectTriggerClass}
              aria-label={t('permissionModeAria', { name: label })}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={locked || busy}
              onClick={() => { setOpen(!open) }}
            >
              {current === undefined ? null : <span className={styles.permissionSelectIconClass}><ClaudePermissionModeGlyph mode={current} /></span>}
              <span className={styles.permissionSelectLabelClass}>{label}</span>
              <svg className={styles.permissionSelectChevronClass} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" data-open={open ? '' : undefined}>
                <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </Tooltip>
        }
      />
      <RiskConfirmation
        open={confirming !== null}
        title={t('permissionBypassTitle')}
        description={t('permissionBypassDescription')}
        acknowledgeLabel={t('permissionBypassAcknowledge')}
        cancelLabel={t('permissionBypassCancel')}
        closeLabel={t('permissionBypassClose')}
        confirmLabel={t('permissionBypassConfirm')}
        acknowledged={acknowledged}
        disabled={locked}
        onAcknowledgedChange={setAcknowledged}
        onCancel={closeConfirmation}
        onConfirm={() => {
          if (locked || !acknowledged || confirming === null) return
          const mode = confirming
          closeConfirmation()
          submit(mode)
        }}
      />
    </span>
  )
}
