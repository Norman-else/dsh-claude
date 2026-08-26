import type { CSSProperties } from 'react'

export const iconChipRunning: CSSProperties = {
  color: 'var(--dsw-static-blue-450)',
}

export const iconChipError: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
}

export const chevron: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '20px',
  transition: 'transform 120ms ease',
  userSelect: 'none',
}

export const chevronOpen: CSSProperties = {
  transform: 'rotate(90deg)',
}

export const detailCode: CSSProperties = {
  maxHeight: 220,
  overflow: 'auto',
  margin: '5px 0 0',
  padding: '8px 10px',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
  lineHeight: '17px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

export const settingsPage: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  width: '100%',
  maxWidth: 820,
  paddingBottom: 28,
}

export const settingsHero: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '2px 2px 8px',
}

export const settingsMark: CSSProperties = {
  width: 42,
  height: 42,
  display: 'grid',
  placeItems: 'center',
  flex: 'none',
  borderRadius: 13,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-static-blue-450)',
  fontSize: 18,
  fontWeight: 700,
}

export const settingsHeading: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 20,
  lineHeight: '28px',
  fontWeight: 650,
}

export const settingsSectionHeading: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 15,
  lineHeight: '22px',
  fontWeight: 650,
}

export const settingsBody: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 14,
  lineHeight: '22px',
}

export const settingsCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 18,
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 14,
  background: 'var(--dsw-alias-bg-layer-1)',
}

export const settingsCardHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
}

export const diagnosticGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(130px, 0.36fr) minmax(0, 1fr)',
  gap: '10px 18px',
  padding: '14px 0',
  borderTop: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderBottom: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  fontSize: 13,
}

export const diagnosticLabel: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
}

export const diagnosticValue: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 500,
  overflowWrap: 'anywhere',
}

export const settingSelect: CSSProperties = {
  position: 'relative',
  minWidth: 0,
}

export const settingTextInput: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  minHeight: 38,
  padding: '7px 13px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
}

export const settingSelectTrigger: CSSProperties = {
  width: '100%',
  minHeight: 38,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '7px 11px 7px 13px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: '0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  textAlign: 'left',
  cursor: 'pointer',
  transition: 'border-color 120ms ease, box-shadow 120ms ease, background 120ms ease',
}

export const settingSelectTriggerOpen: CSSProperties = {
  borderColor: 'var(--dsw-static-blue-450)',
  boxShadow: '0 0 0 3px color-mix(in srgb, var(--dsw-static-blue-450) 15%, transparent)',
}

export const settingSelectValue: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const settingSelectChevron: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 16,
  lineHeight: 1,
  transform: 'translateY(-1px)',
  transition: 'transform 120ms ease',
}

export const settingSelectChevronOpen: CSSProperties = {
  transform: 'translateY(1px) rotate(180deg)',
}

export const settingSelectMenu: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  top: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  maxHeight: 240,
  overflowY: 'auto',
  padding: 5,
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 11,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent), 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
}

export const settingSelectOption: CSSProperties = {
  width: '100%',
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 9px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  textAlign: 'left',
  cursor: 'pointer',
}

export const settingSelectOptionActive: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
}

export const settingSelectCheck: CSSProperties = {
  width: 14,
  flex: 'none',
  color: 'var(--dsw-static-blue-450)',
  fontSize: 12,
  fontWeight: 700,
  textAlign: 'center',
}

export const settingsActions: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
}

export const notice: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  borderRadius: 9,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: '18px',
}

export const button: CSSProperties = {
  alignSelf: 'flex-start',
  flex: 'none',
  minHeight: 34,
  padding: '6px 14px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 9,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 550,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

export const primaryButton: CSSProperties = {
  ...button,
  borderColor: 'transparent',
  background: 'var(--dsw-static-blue-450)',
  color: 'var(--dsw-static-white)',
}

/* Claude tasks details panel (right sidebar). */

export const tasksPanel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'calc(100% - 16px)',
  height: 'calc(100% - 16px)',
  minWidth: 0,
  margin: 8,
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 4px 16px color-mix(in srgb, #000 12%, transparent)',
}

export const tasksHeader: CSSProperties = {
  boxSizing: 'border-box',
  height: 58,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '9px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
}

export const tasksHeading: CSSProperties = {
  display: 'block',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 15,
  lineHeight: '20px',
  fontWeight: 600,
}

export const tasksTurnMeta: CSSProperties = {
  display: 'block',
  marginTop: 1,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '17px',
}

export const panelIconButtonClass = 'dshClaudePanelIconButton'

export const panelIconButtonCss = `
.${panelIconButtonClass} {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.${panelIconButtonClass}:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
}
.${panelIconButtonClass}:active {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);
}
.${panelIconButtonClass}:focus-visible {
  outline: 2px solid var(--dsw-static-blue-450);
  outline-offset: 1px;
}
`

export const tasksBody: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '12px 14px 20px',
  background: 'var(--dsw-alias-bg-base)',
}

export const tasksGroupHeading: CSSProperties = {
  minHeight: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

export const tasksGroupTitle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 14,
  lineHeight: '22px',
  fontWeight: 600,
}

export const tasksGroupToggle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  fontWeight: 600,
  cursor: 'pointer',
}

export const tasksGroupCount: CSSProperties = {
  minWidth: 18,
  padding: '0 5px',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '18px',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
}

export const tasksGroupEmpty: CSSProperties = {
  margin: '5px 4px 2px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
}

export const tasksFinishedSection: CSSProperties = {
  marginTop: 12,
  paddingTop: 8,
  borderTop: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
}

export const taskCardList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 4,
}

export const taskCard: CSSProperties = {
  padding: '11px 12px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 1px 3px color-mix(in srgb, #000 7%, transparent)',
}

export const taskCardRunning: CSSProperties = {
  borderColor: 'var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 24%, transparent))',
}

export const taskCardTop: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 9,
}

export const taskCardGlyph: CSSProperties = {
  width: 18,
  height: 18,
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  marginTop: 1,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: 1,
}

export const taskCardBody: CSSProperties = {
  flex: 1,
  minWidth: 0,
}

export const taskTitle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 550,
  overflowWrap: 'anywhere',
}

export const taskStatusLine: CSSProperties = {
  margin: '1px 0 0',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '17px',
}

export const taskMeta: CSSProperties = {
  margin: '7px 0 0 27px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '17px',
  overflowWrap: 'anywhere',
}

export const taskSummary: CSSProperties = {
  margin: '6px 0 0 27px',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

export const taskTextButton: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-static-blue-450)',
  font: 'inherit',
  fontSize: 11,
  lineHeight: '18px',
  cursor: 'pointer',
}

export const taskActivitySection: CSSProperties = {
  margin: '7px 0 0 27px',
}

export const taskActivityList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  margin: '7px 0 0',
  padding: '8px 9px',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  listStyle: 'none',
}

export const taskActivityItem: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
}

export const taskActivityGlyph: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '17px',
}

export const taskActivityBody: CSSProperties = {
  flex: 1,
  minWidth: 0,
}

export const taskActivityTitle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
  lineHeight: '17px',
  fontWeight: 500,
  overflowWrap: 'anywhere',
}

export const taskActivitySummary: CSSProperties = {
  margin: '1px 0 0',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '17px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

export const taskActivityDetail: CSSProperties = {
  marginTop: 3,
}

export const taskActivityDetailSummary: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 10,
  lineHeight: '16px',
  cursor: 'pointer',
}

export const tasksBadge: CSSProperties = {
  position: 'absolute',
  top: -3,
  right: -5,
  minWidth: 14,
  height: 14,
  display: 'grid',
  placeItems: 'center',
  padding: '0 3px',
  borderRadius: 999,
  background: 'var(--dsw-static-blue-450)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
  fontSize: 9,
  lineHeight: '1',
  fontWeight: 600,
}

/* Claude task launcher attached to the owning conversation turn (minimal
 * entry: a link-style label at the turn tail, hover reveals the task list). */

export const tasksBadgeWrap: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-start',
  margin: '8px 0 4px',
}

export const tasksBadgeSeat: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
}

export const tasksTurnBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 4px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-static-blue-450)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  fontVariantNumeric: 'tabular-nums',
  cursor: 'pointer',
  transition: 'color 120ms ease, opacity 120ms ease',
}

export const tasksBadgeHovered: CSSProperties = {
  textDecoration: 'underline',
}

export const tasksBadgeDone: CSSProperties = {
  opacity: 0.7,
}

export const tasksBadgeDot: CSSProperties = {
  width: 8,
  height: 8,
  flex: 'none',
  borderRadius: 999,
  background: 'var(--dsw-static-blue-450)',
}

export const tasksBadgeDotError: CSSProperties = {
  background: 'var(--dsw-alias-state-error-primary)',
}

export const tasksBadgeDotDone: CSSProperties = {
  background: 'var(--dsw-alias-state-success-primary, var(--dsw-static-green-500))',
}

export const tasksBadgeLabel: CSSProperties = {
  fontWeight: 500,
}

export const tasksHoverCard: CSSProperties = {
  position: 'absolute',
  left: 0,
  bottom: 'calc(100% + 8px)',
  zIndex: 40,
  minWidth: 240,
  maxWidth: 340,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: '0 8px 24px color-mix(in srgb, #000 24%, transparent)',
  fontSize: 12,
  lineHeight: '18px',
  pointerEvents: 'auto',
}

export const tasksHoverHeader: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 600,
}

export const tasksHoverRow: CSSProperties = {
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
}

export const tasksHoverGlyph: CSSProperties = {
  width: 12,
  flex: 'none',
  textAlign: 'center',
  fontSize: 10,
  lineHeight: 1,
  fontWeight: 700,
}

export const tasksHoverGlyphRunning: CSSProperties = {
  color: 'var(--dsw-static-blue-450)',
}

export const tasksHoverGlyphError: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
}

export const tasksHoverGlyphDone: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary, var(--dsw-static-green-500))',
}

export const tasksHoverDesc: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-secondary)',
}

export const tasksHoverType: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 10,
}

export const tasksHoverMore: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
}

export const tasksHoverHint: CSSProperties = {
  marginTop: 2,
  paddingTop: 6,
  borderTop: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent))',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
}

/* Claude repository setup controls on the blank-session hero. */

export const heroRepositoryControls: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

export const heroRepositoryCapsule: CSSProperties = {
  height: 30,
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 0,
  padding: 2,
  border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent))',
  borderRadius: 10,
  background: 'var(--dsw-alias-interactive-bg-base, var(--dsw-alias-bg-layer-1))',
  color: 'var(--dsw-alias-label-secondary)',
}

export const heroBranchPicker: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  minWidth: 0,
}

export const heroBranchTrigger: CSSProperties = {
  height: 26,
  maxWidth: 230,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  padding: '0 7px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
}

export const heroBranchName: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-primary)',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const heroBranchMenu: CSSProperties = {
  position: 'absolute',
  zIndex: 1100,
  top: 'calc(100% + 6px)',
  left: 0,
  width: 280,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 4,
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 10,
  background: 'var(--dsw-specific-menu)',
  boxShadow: 'var(--dsw-shadow-lv3)',
}

export const heroBranchSearch: CSSProperties = {
  height: 32,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 8px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 7,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-tertiary)',
}

export const heroBranchSearchInput: CSSProperties = {
  minWidth: 0,
  flex: 1,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
}

export const heroBranchList: CSSProperties = {
  maxHeight: 170,
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
}

export const heroBranchItem: CSSProperties = {
  width: '100%',
  height: 34,
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 9px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  textAlign: 'left',
  cursor: 'pointer',
}

export const heroBranchItemActive: CSSProperties = {
  background: 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))',
}

export const heroBranchItemName: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const heroBranchEmpty: CSSProperties = {
  height: 34,
  display: 'grid',
  placeItems: 'center',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
}

export const heroRepositoryDivider: CSSProperties = {
  width: 1,
  height: 16,
  flex: 'none',
  background: 'var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
}

export const heroWorktreeToggle: CSSProperties = {
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 7px',
  border: 'none',
  borderRadius: 7,
  outline: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  transition: 'background 120ms ease, color 120ms ease, box-shadow 120ms ease',
}

export const heroWorktreeToggleActive: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-static-blue-450) 10%, transparent)',
  color: 'var(--dsw-alias-label-primary)',
}

export const heroWorktreeToggleFocused: CSSProperties = {
  boxShadow: '0 0 0 2px color-mix(in srgb, var(--dsw-static-blue-450) 28%, transparent)',
}

export const heroWorktreeCheckbox: CSSProperties = {
  width: 15,
  height: 15,
  boxSizing: 'border-box',
  display: 'grid',
  placeItems: 'center',
  flex: 'none',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'inset 0 1px 1px rgba(0, 0, 0, 0.08)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
  transition: 'border-color 120ms ease, background 120ms ease, box-shadow 120ms ease',
}

export const heroWorktreeCheckboxChecked: CSSProperties = {
  borderColor: 'var(--dsw-static-blue-450)',
  background: 'var(--dsw-static-blue-450)',
  boxShadow: '0 1px 3px color-mix(in srgb, var(--dsw-static-blue-450) 35%, transparent)',
}

export const heroWorktreeCheckboxIcon: CSSProperties = {
  width: 12,
  height: 12,
  display: 'block',
}

export const heroWorktreeProgressCard: CSSProperties = {
  position: 'absolute',
  zIndex: 1050,
  top: 'calc(100% + 10px)',
  left: 0,
  width: 320,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 14,
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: 'var(--dsw-shadow-lv3)',
}

export const heroWorktreeProgressHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
}

export const heroWorktreeProgressSpinner: CSSProperties = {
  width: 18,
  height: 18,
  flex: 'none',
  color: 'var(--dsw-static-blue-450)',
}

export const heroWorktreeProgressError: CSSProperties = {
  width: 18,
  height: 18,
  display: 'grid',
  placeItems: 'center',
  flex: 'none',
  borderRadius: '50%',
  background: 'var(--dsw-alias-state-error-primary)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
  fontSize: 13,
  lineHeight: 1,
}

export const heroWorktreeProgressCopy: CSSProperties = {
  minWidth: 0,
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  gap: 2,
}

export const heroWorktreeProgressTitle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: '18px',
  fontWeight: 600,
}

export const heroWorktreeProgressCurrent: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: '18px',
  overflowWrap: 'anywhere',
}

export const heroWorktreeProgressDismiss: CSSProperties = {
  width: 24,
  height: 24,
  display: 'grid',
  placeItems: 'center',
  flex: 'none',
  padding: 0,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  cursor: 'pointer',
}

export const heroWorktreeProgressSteps: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  paddingLeft: 2,
}

export const heroWorktreeProgressStep: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
  lineHeight: '16px',
}

export const heroWorktreeProgressDot: CSSProperties = {
  width: 14,
  height: 14,
  display: 'grid',
  placeItems: 'center',
  flex: 'none',
  boxSizing: 'border-box',
  borderRadius: '50%',
  fontSize: 9,
  lineHeight: 1,
}

export const heroWorktreeProgressDotDone: CSSProperties = {
  background: 'var(--dsw-static-blue-450)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
}

export const heroWorktreeProgressDotActive: CSSProperties = {
  border: '2px solid var(--dsw-static-blue-450)',
}

export const heroRepositoryStatus: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  whiteSpace: 'nowrap',
}

export const heroRepositoryError: CSSProperties = {
  maxWidth: 240,
  overflow: 'hidden',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 11,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/* Claude repository readout and details panel. */

export const repositoryBarFrame: CSSProperties = {
  width: 'calc(100% - 64px)',
  maxWidth: 'var(--dsh-conversation-composer-max-width, 782px)',
  minWidth: 0,
  margin: '0 auto',
  boxSizing: 'border-box',
}

export const repositoryBar: CSSProperties = {
  width: '100%',
  minWidth: 0,
  minHeight: 42,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '7px 11px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 11,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: '0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  textAlign: 'left',
}

/* Queue strip replacing the Host dock entry; mirrors the repository bar. */

export const queueBar: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  padding: '3px 6px 3px 11px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 11,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: '0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
}

export const queueHeader: CSSProperties = {
  width: '100%',
  minHeight: 30,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '2px 0',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
}

export const queueLead: CSSProperties = {
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--dsw-alias-label-tertiary)',
}

export const queueCount: CSSProperties = {
  minWidth: 0,
  flex: 1,
  fontWeight: 550,
}

export const queueList: CSSProperties = {
  maxHeight: 180,
  margin: 0,
  padding: 0,
  listStyle: 'none',
  overflowY: 'auto',
}

export const queueRow: CSSProperties = {
  minHeight: 30,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

export const queueRowDivider: CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent))',
}

export const queuePreview: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-secondary)',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const queueEditor: CSSProperties = {
  minWidth: 0,
  flex: 1,
  height: 26,
  boxSizing: 'border-box',
  padding: '0 8px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 6,
  outline: 'none',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
}

export const queueActions: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
}

export const repositoryBarMerged: CSSProperties = {
  borderColor: 'color-mix(in srgb, #a78bfa 30%, var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent)))',
  background: 'color-mix(in srgb, #a78bfa 5%, var(--dsw-alias-bg-layer-1))',
}

export const repositoryPrIcon: CSSProperties = {
  width: 20,
  height: 20,
  display: 'grid',
  placeItems: 'center',
  flex: 'none',
  borderRadius: 6,
  color: 'var(--dsw-alias-state-success-primary, var(--dsw-static-blue-450))',
}

export const repositoryPrIconMerged: CSSProperties = {
  color: '#a78bfa',
}

export const repositoryPrimary: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  fontWeight: 600,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const repositoryPrLinkFrame: CSSProperties = {
  position: 'relative',
  flex: 'none',
}

export const repositoryPrLink: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary)',
  fontSize: 13,
  fontWeight: 650,
  textDecoration: 'none',
  cursor: 'pointer',
}

export const repositoryPrLinkMerged: CSSProperties = {
  color: '#a78bfa',
}

export const repositoryPrHoverCard: CSSProperties = {
  position: 'absolute',
  zIndex: 30,
  left: -34,
  bottom: 'calc(100% + 14px)',
  width: 340,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '13px 14px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 14px 38px color-mix(in srgb, #000 34%, transparent)',
  color: 'var(--dsw-alias-label-primary)',
  pointerEvents: 'auto',
}

export const repositoryPrHoverTop: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minWidth: 0,
}

export const repositoryPrStateBadge: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent)',
  color: 'var(--dsw-alias-state-success-primary)',
  fontSize: 11,
  fontWeight: 650,
}

export const repositoryPrStateBadgeMerged: CSSProperties = {
  background: 'color-mix(in srgb, #a78bfa 18%, transparent)',
  color: '#a78bfa',
}

export const repositoryPrHoverRepo: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const repositoryPrHoverAge: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
}

export const repositoryPrHoverTitle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 650,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
  cursor: 'pointer',
}

export const repositoryPrHoverBottom: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

export const repositoryPrAuthor: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
}

export const repositoryPrAvatar: CSSProperties = {
  width: 18,
  height: 18,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 9,
  fontWeight: 700,
}

export const repositoryPrHoverStats: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  fontWeight: 650,
}

export const repositoryPrFiles: CSSProperties = {
  padding: '2px 7px',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontWeight: 500,
}
export const repositoryRemote: CSSProperties = {
  minWidth: 0,
  maxWidth: 116,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const repositoryBranch: CSSProperties = {
  minWidth: 0,
  maxWidth: 125,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  fontWeight: 550,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const repositoryWorktree: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
}

export const repositoryStatusItems: CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  overflow: 'hidden',
}

export const repositoryItem: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  fontWeight: 550,
  whiteSpace: 'nowrap',
}

export const repositoryItemLabel: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export const repositoryItemDot: CSSProperties = {
  width: 6,
  height: 6,
  flex: 'none',
  borderRadius: 999,
  background: 'currentColor',
}

export const repositoryItemSuccess: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary)',
}

export const repositoryItemWarning: CSSProperties = {
  color: 'var(--dsw-alias-state-warning-primary, #d69e2e)',
}

export const repositoryItemError: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
}

export const repositoryMergedStatus: CSSProperties = {
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  overflow: 'hidden',
  color: '#a78bfa',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
}

export const repositoryMergedDot: CSSProperties = {
  width: 6,
  height: 6,
  flex: 'none',
  borderRadius: 999,
  background: 'currentColor',
}

export const repositoryMergedAge: CSSProperties = {
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-tertiary)',
  fontWeight: 500,
  textOverflow: 'ellipsis',
}

export const diffTrigger: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  minHeight: 26,
  padding: '3px 8px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 7,
  background: 'var(--dsw-alias-bg-layer-2)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  fontWeight: 650,
  cursor: 'pointer',
}

export const diffTriggerMuted: CSSProperties = {
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
}

export const repositoryAutoFix: CSSProperties = {
  width: 26,
  minHeight: 26,
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 7,
  outline: 'none',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  lineHeight: '18px',
  cursor: 'pointer',
}

export const repositoryAutoFixActive: CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--dsw-static-blue-450) 45%, transparent)',
  background: 'color-mix(in srgb, var(--dsw-static-blue-450) 12%, transparent)',
  color: 'var(--dsw-static-blue-450)',
}

export const repositoryUpdateTrigger: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  minHeight: 26,
  padding: '3px 8px',
  border: '1px solid color-mix(in srgb, var(--dsw-static-blue-450) 45%, transparent)',
  borderRadius: 7,
  background: 'color-mix(in srgb, var(--dsw-static-blue-450) 12%, transparent)',
  color: 'var(--dsw-static-blue-450)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  fontWeight: 650,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

export const repositoryChecksFrame: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  minWidth: 0,
}

export const repositoryChecksTrigger: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
}

export const repositoryChecksCard: CSSProperties = {
  position: 'absolute',
  zIndex: 1100,
  bottom: 'calc(100% + 8px)',
  right: 0,
  width: 320,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 8,
  padding: 12,
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 10,
  background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1))',
  boxShadow: 'var(--dsw-shadow-lv3)',
  textAlign: 'left',
  cursor: 'default',
}

export const repositoryChecksTitle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  fontWeight: 650,
}

export const repositoryChecksHint: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
}

export const repositoryChecksError: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 12,
}

export const repositoryChecksItem: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}

export const repositoryChecksName: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const repositoryChecksDesc: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const repositoryChecksFix: CSSProperties = {
  alignSelf: 'flex-end',
  minHeight: 26,
  padding: '3px 10px',
  border: 'none',
  borderRadius: 7,
  background: 'var(--dsw-static-blue-450)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 650,
  cursor: 'pointer',
}

export const diffPrCommentsButton: CSSProperties = {
  minHeight: 28,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 7,
  background: 'var(--dsw-alias-bg-layer-2)',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 650,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

export const diffGhCommentAuthor: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontWeight: 600,
}

export const diffGhCommentLink: CSSProperties = {
  color: 'var(--dsw-static-blue-450)',
  textDecoration: 'none',
  fontWeight: 650,
}

export const diffModalConflicts: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  margin: 0,
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  fontSize: 12,
  listStyle: 'none',
}

export const diffModalConflictResolve: CSSProperties = {
  alignSelf: 'flex-start',
  minHeight: 28,
  padding: '4px 12px',
  border: 'none',
  borderRadius: 7,
  background: 'var(--dsw-static-blue-450)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 650,
  cursor: 'pointer',
}

export const heroIssueTrigger: CSSProperties = {
  height: 30,
  maxWidth: 260,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  padding: '0 9px',
  border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent))',
  borderRadius: 10,
  outline: 'none',
  background: 'var(--dsw-alias-interactive-bg-base, var(--dsw-alias-bg-layer-1))',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

export const heroIssueTriggerActive: CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--dsw-static-blue-450) 45%, transparent)',
  color: 'var(--dsw-alias-label-primary)',
}

export const heroIssueLabel: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const repositoryPrIconButton: CSSProperties = {
  padding: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  font: 'inherit',
  cursor: 'pointer',
}

export const overviewBody: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 10,
  overflowY: 'auto',
}

export const overviewRow: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 10,
  outline: 'none',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

export const overviewRowTop: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

export const overviewTitle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  fontSize: 13,
  fontWeight: 600,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const overviewMeta: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  whiteSpace: 'nowrap',
}

export const overviewBranch: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export const overviewRunningDot: CSSProperties = {
  width: 7,
  height: 7,
  flex: 'none',
  borderRadius: 999,
  background: 'var(--dsw-static-blue-450)',
}

export const overviewEmpty: CSSProperties = {
  padding: 16,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 13,
  textAlign: 'center',
}

export const repositoryMergeTrigger: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  minHeight: 26,
  padding: '3px 8px',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)',
  borderRadius: 7,
  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)',
  color: 'var(--dsw-alias-state-success-primary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  fontWeight: 650,
  cursor: 'pointer',
}

export const diffAdd: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary)',
}

export const diffDelete: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
}

export const diffCommentButtonClass = 'dshClaudeDiffCommentButton'
export const diffLineRowClass = 'dshClaudeDiffLineRow'
export const diffCommentTextareaClass = 'dshClaudeDiffCommentTextarea'

export const diffCommentCss = `
.${diffCommentButtonClass} {
  width: 18px;
  height: 18px;
  flex: none;
  display: grid;
  place-items: center;
  align-self: center;
  margin: 0 2px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: var(--dsw-static-blue-450);
  color: var(--dsw-alias-label-on-accent, #fff);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 100ms ease;
}
.${diffLineRowClass}:hover .${diffCommentButtonClass},
.${diffCommentButtonClass}:focus-visible {
  opacity: 1;
}
.${diffCommentButtonClass}[disabled] {
  visibility: hidden;
}
.${diffCommentTextareaClass}:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--dsw-static-blue-450);
}
`

export const diffCommentBlock: CSSProperties = {
  boxSizing: 'border-box',
  width: 'min(640px, calc(var(--dsh-claude-diff-viewport, 520px) - 72px))',
  position: 'sticky',
  left: 62,
  margin: '4px 8px 8px 62px',
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  fontFamily: 'var(--dsw-font-family, system-ui)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'normal',
}

export const diffCommentCardText: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  overflowWrap: 'anywhere',
}

export const diffCommentCardMeta: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 4,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
}

export const diffCommentTextarea: CSSProperties = {
  width: '100%',
  minHeight: 56,
  boxSizing: 'border-box',
  padding: '6px 8px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  resize: 'vertical',
}

export const diffCommentActions: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 6,
}

export const diffCommentActionButton: CSSProperties = {
  minHeight: 24,
  padding: '2px 10px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

export const diffCommentSubmitButton: CSSProperties = {
  border: 'none',
  background: 'var(--dsw-static-blue-450)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
  fontWeight: 600,
}

export const diffCommentError: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 11,
}

export const reviewCommentBarFrame: CSSProperties = {
  width: 'calc(100% - 64px)',
  maxWidth: 'var(--dsh-conversation-composer-max-width, 782px)',
  margin: '0 auto',
  boxSizing: 'border-box',
}

export const reviewCommentBar: CSSProperties = {
  width: '100%',
  minWidth: 0,
  minHeight: 42,
  boxSizing: 'border-box',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  padding: '7px 11px',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 11,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '20px',
}

export const reviewCommentIcon: CSSProperties = {
  width: 20,
  height: 20,
  display: 'grid',
  placeItems: 'center',
  flex: 'none',
  color: 'var(--dsw-static-blue-450)',
}

export const reviewCommentClearSeat: CSSProperties = {
  marginLeft: 'auto',
  alignSelf: 'flex-start',
  flex: 'none',
  display: 'inline-flex',
}

export const reviewCommentChip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  maxWidth: 240,
  padding: '1px 4px 1px 9px',
  border: '1px solid color-mix(in srgb, var(--dsw-static-blue-450) 32%, transparent)',
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--dsw-static-blue-450) 10%, transparent)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '20px',
}

export const reviewCommentChipLabel: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const reviewCommentChipRemove: CSSProperties = {
  width: 16,
  height: 16,
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  padding: 0,
  border: 'none',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
}

export const reviewCommentHoverCard: CSSProperties = {
  display: 'block',
  maxWidth: 360,
  padding: '8px 10px',
  fontSize: 12,
  lineHeight: '18px',
}

export const reviewCommentHoverPath: CSSProperties = {
  display: 'block',
  marginBottom: 4,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  overflowWrap: 'anywhere',
}

export const reviewCommentHoverText: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

export const diffAhead: CSSProperties = {
  color: 'var(--dsw-static-blue-450)',
}

export const diffAheadMuted: CSSProperties = {
  color: 'color-mix(in srgb, var(--dsw-static-blue-450) 62%, var(--dsw-alias-label-tertiary))',
}

export const diffAddMuted: CSSProperties = {
  color: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 62%, var(--dsw-alias-label-tertiary))',
}

export const diffDeleteMuted: CSSProperties = {
  color: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 62%, var(--dsw-alias-label-tertiary))',
}

export const diffPanel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'calc(100% - 16px)',
  height: 'calc(100% - 16px)',
  minWidth: 0,
  margin: 8,
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 4px 16px color-mix(in srgb, #000 12%, transparent)',
}

export const diffPanelMaximized: CSSProperties = {
  width: '100%',
  height: '100%',
  margin: 0,
}

export const diffHeader: CSSProperties = {
  boxSizing: 'border-box',
  height: 49,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '9px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
}

export const diffHeaderTitle: CSSProperties = {
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 15,
  fontWeight: 650,
  whiteSpace: 'nowrap',
}

export const diffHeaderLabel: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export const diffHeaderActions: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 5,
}

export const diffSplitButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'stretch',
}

export const diffCommitButton: CSSProperties = {
  minHeight: 28,
  padding: '4px 10px',
  border: 'none',
  borderRadius: '7px 0 0 7px',
  background: 'var(--dsw-static-blue-450)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 650,
  cursor: 'pointer',
}

export const diffActionDisabled: CSSProperties = {
  opacity: 0.45,
  cursor: 'default',
}

export const diffCommitMenuButton: CSSProperties = {
  width: 28,
  minHeight: 28,
  display: 'grid',
  placeItems: 'center',
  padding: 0,
  border: 'none',
  borderLeft: '1px solid color-mix(in srgb, #fff 32%, transparent)',
  borderRadius: '0 7px 7px 0',
  background: 'var(--dsw-static-blue-450)',
  color: 'var(--dsw-alias-label-on-accent, #fff)',
  font: 'inherit',
  cursor: 'pointer',
}

export const diffHeaderBranch: CSSProperties = {
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  fontWeight: 500,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const diffSummary: CSSProperties = {
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '6px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
}

export const diffBody: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  background: 'var(--dsw-alias-bg-base)',
}

export const diffFile: CSSProperties = {
  borderBottom: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
}

export const diffFileHeader: CSSProperties = {
  width: '100%',
  minHeight: 38,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '7px 10px',
  border: 'none',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
}

export const diffFilePath: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const diffFileStats: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  gap: 4,
  fontSize: 12,
  fontWeight: 650,
}

export const diffCode: CSSProperties = {
  minWidth: 'max-content',
  padding: '4px 0 8px',
  background: 'var(--dsw-alias-bg-base)',
  fontFamily: 'var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace)',
  fontSize: 14,
  lineHeight: '22px',
}

export const diffLine: CSSProperties = {
  minHeight: 17,
  display: 'flex',
  whiteSpace: 'pre',
}

export const diffLineNumber: CSSProperties = {
  width: 38,
  flex: 'none',
  paddingRight: 8,
  color: 'var(--dsw-alias-label-tertiary)',
  textAlign: 'right',
  userSelect: 'none',
}

export const diffLineMarker: CSSProperties = {
  width: 16,
  flex: 'none',
  color: 'inherit',
  textAlign: 'center',
  userSelect: 'none',
}

export const diffLineAdd: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
  color: 'var(--dsw-alias-state-success-primary)',
}

export const diffLineDelete: CSSProperties = {
  background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, transparent)',
  color: 'var(--dsw-alias-state-error-primary)',
}

export const diffLineHunk: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontStyle: 'italic',
}

export const diffLineContext: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
}

export const diffNotice: CSSProperties = {
  margin: 10,
  padding: '9px 10px',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
  lineHeight: '17px',
}

export const diffEmpty: CSSProperties = {
  margin: 16,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
}

export const diffModalCss = `
.dshClaudeRepositoryActionModal {
  box-sizing: border-box;
  width: min(760px, calc(100vw - 48px));
  max-width: calc(100vw - 48px);
  max-height: min(680px, calc(100vh - 48px));
}
.dshClaudeRepositoryActionModalContent {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.dshClaudeRepositoryActionModalContent > div:first-child {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--dsw-alias-bg-layer-2);
}
.dshClaudeRepositoryActionModalContent h2 {
  font-size: 24px;
  line-height: 32px;
}
.dshClaudeRepositoryActionModalContent > p {
  font-size: 18px;
  line-height: 28px;
}
.dshClaudeRepositoryActionModal input[type='checkbox'] {
  width: 18px;
  height: 18px;
}
.dshClaudeRepositoryActionModal textarea:focus,
.dshClaudeRepositoryActionModal input:not([type='checkbox']):focus {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--dsw-static-blue-450);
}
`

export const diffModalBody: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
}

export const diffModalMeta: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16,
  minWidth: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 16,
  lineHeight: '24px',
}

export const diffModalMetaText: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const diffModalFiles: CSSProperties = {
  minWidth: 0,
  maxHeight: 300,
  overflowX: 'hidden',
  overflowY: 'auto',
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  borderRadius: 8,
}

export const diffModalFile: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  minWidth: 0,
  padding: '10px 14px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 15,
  lineHeight: '22px',
}

export const diffModalFilePath: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const diffModalFileState: CSSProperties = {
  flex: 'none',
}

export const diffModalField: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 16,
  lineHeight: '24px',
  fontWeight: 550,
}

export const diffModalTextarea: CSSProperties = {
  ...settingTextInput,
  minHeight: 140,
  padding: '10px 14px',
  fontSize: 16,
  lineHeight: '24px',
  resize: 'vertical',
}

export const diffModalTextInput: CSSProperties = {
  ...settingTextInput,
  minHeight: 44,
  padding: '9px 14px',
  fontSize: 16,
  lineHeight: '24px',
}

export const diffModalCheckbox: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 16,
  lineHeight: '24px',
}

export const diffModalFooter: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 12,
}

export const diffModalButton: CSSProperties = {
  minHeight: 42,
  padding: '8px 18px',
  fontSize: 16,
  lineHeight: '24px',
}

export const diffModalStatus: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 16,
  lineHeight: '24px',
}

export const diffModalError: CSSProperties = {
  margin: '10px 0 0',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 16,
  lineHeight: '24px',
}

export const diffModalSuccess: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-state-success-primary)',
  fontSize: 16,
  lineHeight: '24px',
}
