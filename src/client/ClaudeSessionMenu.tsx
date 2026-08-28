import { useEffect, useRef, useState } from 'react'
import {
  IconChevronRightOutline14,
  IconEllipsisOutline16,
  Tooltip,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeClientProjection } from './projection.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { EditorId } from '../editor-open.ts'
import { openProjectInEditor } from './editor-open-api.ts'

export interface ClaudeSessionMenuInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
}

export interface ClaudeSessionMenuProps extends ClaudeSessionMenuInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
  sessionId: string
  /** Seam for tests; defaults to the host route that launches the editor. */
  openInEditor?: (sessionId: string, editor: EditorId) => Promise<void>
}

/** Trigger matches the neighbouring diff action; the cards reproduce the
 *  primitives' menu surface (r12, inverted hairline, shadow-lv3, 4px inset).
 *
 *  Hand-rolled rather than the `Menu` primitive because this menu needs its
 *  submenu on the LEFT: the trigger is the header's rightmost control, and the
 *  primitive's nested card is pinned to `left: 100%`, which would open the
 *  editor list off the right edge of the window. */
const MENU_CSS = [
  '.dsh-claude-header-menu-root{position:relative;display:inline-flex}',
  '.dsh-claude-header-menu{flex:none;display:inline-flex;align-items:center;justify-content:center;',
    'width:32px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;',
    'color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,color .12s ease}',
  '.dsh-claude-header-menu:hover,.dsh-claude-header-menu:focus-visible,.dsh-claude-header-menu[aria-expanded="true"]{',
    'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-header-menu:active{background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-claude-header-menu:focus-visible{outline:none}',
  // The shared glyph is a horizontal ellipsis; the header wants the vertical
  // kebab, and a quarter turn is cheaper than a second icon.
  '.dsh-claude-header-menu>svg{display:block;transform:rotate(90deg)}',
  // The primitives' compact menu scale (Menu.module.css .compactList): a
  // header dropdown holding two rows reads as a slab at the standard 40px
  // cell height.
  '.dsh-claude-header-menu-card,.dsh-claude-header-menu-sub{box-sizing:border-box;position:absolute;',
    'display:flex;flex-direction:column;padding:2px;border:1px solid var(--dsw-alias-border-inverted);',
    'border-radius:7px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3)}',
  // Anchored under the trigger's right edge: the trigger is the header's last
  // control, so a left-aligned card would hang off the window.
  '.dsh-claude-header-menu-card{top:calc(100% + 4px);right:0;z-index:100;min-width:164px;max-width:360px}',
  // Top-aligned with the parent card and grown leftward and DOWNWARD; the
  // trigger sits against the top of the window, so a card that grew upward
  // from the parent row would run off the viewport.
  '.dsh-claude-header-menu-sub{top:-2px;right:calc(100% + 10px);z-index:101;min-width:164px}',
  // Bridges the 10px gap so the pointer can cross without leaving the row.
  '.dsh-claude-header-menu-sub::after{content:"";position:absolute;top:0;bottom:0;right:-10px;width:10px}',
  '.dsh-claude-header-menu-row{position:relative}',
  '.dsh-claude-header-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:26px;',
    'padding:3px 7px;border:none;border-radius:5px;background:transparent;cursor:pointer;text-align:left;',
    'font-family:var(--dsw-font-family);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
  '.dsh-claude-header-menu-item:hover,.dsh-claude-header-menu-item:focus-visible,',
    '.dsh-claude-header-menu-item[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-claude-header-menu-item:focus-visible{outline:none}',
  '.dsh-claude-header-menu-item>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-claude-header-menu-item>svg{flex:none;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-claude-header-menu-heading{padding:4px 7px;font-family:var(--dsw-font-family);font-size:11px;',
    'line-height:16px;color:var(--dsw-alias-label-tertiary)}',
].join('')

let cssInjected = false
function ensureCss(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  // Drop any sheet a previous module evaluation left behind. Appending
  // blindly stacks rule sets across hot reloads, and two generations of the
  // submenu rule resolve together — an absolutely positioned card that
  // inherits `top` from one and `bottom` from the other gets its height
  // pinned to the gap between them and spills its rows outside the card.
  for (const stale of document.querySelectorAll('style[data-dsh-claude-header-menu]')) stale.remove()
  const element = document.createElement('style')
  element.dataset.dshClaudeHeaderMenu = ''
  element.textContent = MENU_CSS
  document.head.appendChild(element)
}

const EDITORS: readonly { readonly id: EditorId; readonly label: string }[] = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'idea', label: 'IntelliJ IDEA' },
]

/** The open menu, split out so the SSR tests can render it without a DOM to
 *  drive the hover that opens the submenu. */
export function ClaudeSessionMenuCard({ openIn, submenuOpen, failure, onSubmenuOpen, onSelect }: {
  openIn: string
  submenuOpen: boolean
  failure?: string | undefined
  onSubmenuOpen: (open: boolean) => void
  onSelect: (editor: EditorId) => void
}) {
  return (
    <div className="dsh-claude-header-menu-card" role="menu">
      <div
        className="dsh-claude-header-menu-row"
        onMouseEnter={() => onSubmenuOpen(true)}
        onMouseLeave={() => onSubmenuOpen(false)}
      >
        <button
          type="button"
          role="menuitem"
          className="dsh-claude-header-menu-item"
          aria-haspopup="menu"
          aria-expanded={submenuOpen}
          onFocus={() => onSubmenuOpen(true)}
          onClick={() => onSubmenuOpen(true)}
        ><span>{openIn}</span><IconChevronRightOutline14 /></button>
        {submenuOpen ? <div className="dsh-claude-header-menu-sub" role="menu">
          <div className="dsh-claude-header-menu-heading">{openIn}</div>
          {EDITORS.map(editor => <button
            key={editor.id}
            type="button"
            role="menuitem"
            className="dsh-claude-header-menu-item"
            onClick={() => onSelect(editor.id)}
          ><span>{editor.label}</span></button>)}
        </div> : null}
      </div>
      {/* A launch that never happened has to say so somewhere, and the menu
          is the only surface still on screen when it fails. */}
      {failure === undefined ? null : <div className="dsh-claude-header-menu-heading">{failure}</div>}
    </div>
  )
}

export function ClaudeSessionMenu({
  t, sessionId, useClaudeProjection, openInEditor = openProjectInEditor,
}: ClaudeSessionMenuProps) {
  const owned = useClaudeProjection(projection => projection.owned)
  const root = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [submenuOpen, setSubmenuOpen] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const close = (): void => {
    setOpen(false)
    setSubmenuOpen(false)
    setFailure(undefined)
  }
  useDismissOnOutsidePointer(root, open, next => { if (!next) close() })
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])
  // The header action row renders in every Session, including ones driven by
  // other agent presets; only Claude sessions carry a project to open.
  if (!owned) return null
  ensureCss()
  const label = t('sessionMenu')
  const openIn = t('sessionMenuOpenIn')
  const select = (editor: EditorId): void => {
    setFailure(undefined)
    openInEditor(sessionId, editor).then(
      () => close(),
      (error: unknown) => setFailure(t('sessionMenuOpenFailed', { message: error instanceof Error ? error.message : String(error) })),
    )
  }
  return (
    <span className="dsh-claude-header-menu-root" ref={root}>
      {/* The open card already names the action; a bubble on top of it is
          noise. `disabled` keeps the anchor mounted, so toggling it never
          remounts the trigger mid-press. */}
      <Tooltip label={label} side="bottom" delayMs={250} disabled={open}>
        <button
          type="button"
          className="dsh-claude-header-menu"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          data-session={sessionId}
          onClick={() => { if (open) close(); else setOpen(true) }}
        ><IconEllipsisOutline16 /></button>
      </Tooltip>
      {open ? <ClaudeSessionMenuCard
        openIn={openIn}
        submenuOpen={submenuOpen}
        failure={failure}
        onSubmenuOpen={setSubmenuOpen}
        onSelect={select}
      /> : null}
    </span>
  )
}
