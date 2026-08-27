import { useEffect, useSyncExternalStore } from 'react'
import { IconAgentPresetOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { CLAUDE_CODE_PRESET_ID } from '../constants.ts'
import { claudeMarkUrl } from './claude-mark.ts'
import { presetDisplayText, type AgentPresetRow, type HostTranslate } from './agent-preset-roster.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'

export interface ClaudeAgentPresetRosterSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly AgentPresetRow[]
  load(): void
}

export interface ClaudeAgentPresetLabelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  /** Lookup bound to the Host's own preset namespace, so presets DSH ships
   *  keep their translated names under this shadow. */
  hostT: HostTranslate
  roster: ClaudeAgentPresetRosterSource
}

export interface ClaudeAgentPresetLabelProps extends ClaudeAgentPresetLabelInjected {
  useSessions: SnapshotSelectorHook<{ readonly byId: Readonly<Record<string, { readonly agentPreset?: string } | undefined>> }>
  sessionId: string
}

/** Reproduces the Host label's own metrics — it sits in the same action row
 *  beside the title, so it has to read as the same piece of chrome. */
const LABEL_CSS = [
  '.dsh-claude-preset-label{display:inline-flex;align-items:center;gap:4px;max-width:220px;height:22px;',
    'padding:0 2px 0 0;border-radius:6px;overflow:hidden;white-space:nowrap;',
    'color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);font-size:12px;line-height:22px}',
  '.dsh-claude-preset-label>*{flex:none}',
  '.dsh-claude-preset-name{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  // The Host dims its generic glyph; the brand mark carries its own colour and
  // is meant to read at full strength.
  '.dsh-claude-preset-icon{opacity:.7}',
  `.dsh-claude-preset-mark{width:14px;height:14px;background:${claudeMarkUrl()} center/contain no-repeat}`,
].join('')

let cssInjected = false
function ensureCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const element = document.createElement('style')
  element.dataset.dshClaudePresetLabel = ''
  element.textContent = LABEL_CSS
  document.head.appendChild(element)
}

export function ClaudeAgentPresetLabel({ t, hostT, roster, sessionId, useSessions }: ClaudeAgentPresetLabelProps) {
  const preset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const rows = useSyncExternalStore(roster.subscribe, roster.getSnapshot, roster.getSnapshot)
  const { load } = roster
  useEffect(() => {
    if (preset !== undefined) load()
  }, [preset, load])
  // A session records its preset only once it is composed; before that the
  // Host renders nothing here, and so does this.
  if (preset === undefined) return null
  ensureCss()
  const text = presetDisplayText(rows.find(row => row.id === preset), preset, hostT)
  return (
    <Tooltip label={text.description ?? t('presetHeaderHint')} side="bottom" delayMs={250} maxWidth={280}>
      <span className="dsh-claude-preset-label">
        {preset === CLAUDE_CODE_PRESET_ID
          ? <span className="dsh-claude-preset-mark" aria-hidden="true" />
          : <IconAgentPresetOutline16 size={14} className="dsh-claude-preset-icon" />}
        <span className="dsh-claude-preset-name">{text.name}</span>
      </span>
    </Tooltip>
  )
}
