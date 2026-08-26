import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  IconEditOutline16,
  IconQueueOutline14,
  IconSendOutline14,
  IconTrashOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import * as styles from './styles.ts'

export interface QueueRowView {
  readonly id: string
  /** Only queued rows accept mutations; steering/context rows are in flight. */
  readonly placement: 'queued' | 'steering' | 'context'
  readonly preview: string
  /** Editable text; null when the message carries non-text blocks. */
  readonly text: string | null
}

export type QueueActionView =
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }
  | { readonly kind: 'edit'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }

export interface QueueSessionSnapshot {
  readonly queue: readonly QueueRowView[]
  readonly running: boolean
  readonly subagent: unknown
}

export interface ClaudeQueueDockInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  updateQueue: (itemId: string, action: QueueActionView) => Promise<void>
  notify: (level: 'info' | 'error', text: string) => void
}

export interface ClaudeQueueDockProps extends ClaudeQueueDockInjected {
  useSession: SnapshotSelectorHook<QueueSessionSnapshot>
}

/** Replaces the Host queue strip (same slot cell, lower priority) with one
 *  styled like the repository status bar. Behaviour mirrors the Host strip:
 *  one row inline, several rows behind a collapsible count, edit/remove/steer. */
export function ClaudeQueueDock({ useSession, t, updateQueue, notify }: ClaudeQueueDockProps) {
  const inbox = useSession(session => session.queue)
  const queue = useMemo(() => inbox.filter(row => row.placement === 'queued'), [inbox])
  const running = useSession(session => session.running)
  const mutable = useSession(session => session.subagent === null)
  const [editing, setEditing] = useState<{ id: string; text: string }>()
  const [busy, setBusy] = useState<string>()
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()
  useEffect(() => {
    if (queue.length === 0 && !collapsed) setCollapsed(true)
    if (editing !== undefined && (!mutable || !queue.some(row => row.id === editing.id))) setEditing(undefined)
  }, [collapsed, editing, mutable, queue])
  if (queue.length === 0) return null
  const interacting = mutable && (editing !== undefined || busy !== undefined)
  const expanded = !collapsed || interacting
  const listVisible = queue.length === 1 || expanded
  const apply = async (id: string, action: QueueActionView, failure: string): Promise<boolean> => {
    setBusy(id)
    try {
      await updateQueue(id, action)
      return true
    } catch {
      notify('error', failure)
      return false
    } finally {
      setBusy(current => (current === id ? undefined : current))
    }
  }
  const saveEdit = async (): Promise<void> => {
    if (editing === undefined || editing.text.trim() === '') return
    if (await apply(editing.id, { kind: 'edit', content: [{ type: 'text', text: editing.text }] }, t('queueEditFailed'))) setEditing(undefined)
  }
  const action = (label: string, icon: ReactNode, onClick: () => void, disabled: boolean, hint?: string): ReactNode => (
    <Tooltip label={hint ?? label} side="bottom" delayMs={400}>
      <button type="button" className={styles.panelIconButtonClass} aria-label={label} disabled={disabled} onClick={onClick}>{icon}</button>
    </Tooltip>
  )
  return (
    <div style={styles.repositoryBarFrame} data-claude-queue-dock="">
      <style data-dsh-claude-queue-styles>{styles.panelIconButtonCss}</style>
      <div style={styles.queueBar}>
        {queue.length > 1 ? (
          <button type="button" style={styles.queueHeader} aria-controls={listId} aria-expanded={expanded} disabled={interacting} onClick={() => { setCollapsed(value => !value) }}>
            <span style={styles.queueLead} aria-hidden="true"><IconQueueOutline14 /></span>
            <span style={styles.queueCount}>{t('queueCount', { n: queue.length })}</span>
            <span style={styles.queueLead} aria-hidden="true">{expanded ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}</span>
          </button>
        ) : null}
        <ul id={listId} style={styles.queueList} hidden={!listVisible}>
          {listVisible ? queue.map((row, index) => (
            <li key={row.id} style={{ ...styles.queueRow, ...(index > 0 ? styles.queueRowDivider : {}) }}>
              {queue.length === 1 ? <span style={styles.queueLead} aria-hidden="true"><IconQueueOutline14 /></span> : null}
              {editing?.id === row.id ? (
                <input
                  autoFocus
                  style={styles.queueEditor}
                  aria-label={t('queueEdit')}
                  value={editing.text}
                  onChange={event => { setEditing({ id: row.id, text: event.currentTarget.value }) }}
                  onKeyDown={event => {
                    if (event.key === 'Escape') setEditing(undefined)
                    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      void saveEdit()
                    }
                  }}
                />
              ) : <span style={styles.queuePreview}>{row.preview}</span>}
              {mutable ? (
                <span style={styles.queueActions}>
                  {editing?.id === row.id ? <>
                    {action(t('queueSave'), <IconCheckOutline16 size={14} />, () => { void saveEdit() }, busy !== undefined || editing.text.trim() === '')}
                    {action(t('queueCancelEdit'), <IconCloseOutline16 size={14} />, () => { setEditing(undefined) }, busy !== undefined)}
                  </> : <>
                    {action(t('queueEdit'), <IconEditOutline16 size={14} />, () => { if (row.text !== null) setEditing({ id: row.id, text: row.text }) }, busy !== undefined || row.text === null, row.text === null ? t('queueEditUnsupported') : undefined)}
                    {action(t('queueRemove'), <IconTrashOutline16 size={14} />, () => { void apply(row.id, { kind: 'remove' }, t('queueRemoveFailed')) }, busy !== undefined)}
                    {action(t('queueSteer'), <IconSendOutline14 />, () => { void apply(row.id, { kind: 'steer' }, t('queueSteerFailed')) }, busy !== undefined || !running, running ? undefined : t('queueSteerUnavailable'))}
                  </>}
                </span>
              ) : null}
            </li>
          )) : null}
        </ul>
      </div>
    </div>
  )
}
