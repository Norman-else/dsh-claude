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
  fontSize: 13,
  lineHeight: '20px',
}

export const settingsCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 18,
  border: '1px solid var(--dsw-alias-border-l2)',
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
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
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

export const settingSelectTrigger: CSSProperties = {
  width: '100%',
  minHeight: 38,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '7px 11px 7px 13px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: '0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
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
  fontWeight: 550,
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
  border: '1px solid var(--dsw-alias-border-l2)',
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
  fontSize: 13,
  lineHeight: '20px',
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
  border: '1px solid var(--dsw-alias-border-l2)',
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
  height: '100%',
  minWidth: 0,
  background: 'var(--dsw-alias-bg-base)',
}

export const tasksHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '12px 14px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

export const tasksHeading: CSSProperties = {
  display: 'block',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 600,
}

export const tasksTurnMeta: CSSProperties = {
  display: 'block',
  marginTop: 1,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '16px',
}

export const tasksClose: CSSProperties = {
  width: 26,
  height: 26,
  display: 'grid',
  placeItems: 'center',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 15,
  lineHeight: '1',
  cursor: 'pointer',
}

export const tasksBody: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '10px 12px 20px',
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
  fontSize: 12,
  lineHeight: '20px',
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
  fontSize: 12,
  lineHeight: '20px',
  fontWeight: 600,
  cursor: 'pointer',
}

export const tasksGroupCount: CSSProperties = {
  minWidth: 18,
  padding: '0 5px',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 10,
  lineHeight: '17px',
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
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

export const taskCardList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 4,
}

export const taskCard: CSSProperties = {
  padding: '10px 11px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
}

export const taskCardRunning: CSSProperties = {
  borderColor: 'var(--dsw-alias-border-l3)',
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
  fontSize: 13,
  lineHeight: '19px',
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

/* Claude task launcher attached to the owning conversation turn. */

export const tasksTurnLauncher: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  margin: '6px 0 2px',
  padding: '5px 8px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
}

export const tasksTurnLauncherDot: CSSProperties = {
  color: 'var(--dsw-static-blue-450)',
  fontSize: 9,
}

export const tasksTurnLauncherDone: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-tertiary))',
}
