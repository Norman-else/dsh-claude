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
  gap: 18,
  maxWidth: 760,
}

export const settingsHeading: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 20,
  lineHeight: '28px',
  fontWeight: 650,
}

export const settingsBody: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 14,
  lineHeight: '22px',
}

export const diagnosticGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(130px, 0.4fr) minmax(0, 1fr)',
  gap: '9px 18px',
  padding: '16px 0',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  fontSize: 13,
}

export const diagnosticLabel: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
}

export const diagnosticValue: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  overflowWrap: 'anywhere',
}

export const button: CSSProperties = {
  alignSelf: 'flex-start',
  minHeight: 34,
  padding: '6px 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 18,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
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
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 600,
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

/* Claude tasks session-header button (next to Session log). */

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

export const tasksTriggerHoverCss = '.dsh-claude-tasks-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}'

export const tasksHeaderButton: CSSProperties = {
  height: 32,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  padding: '6px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 18,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: 13,
  fontWeight: 400,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

export const tasksHeaderButtonActive: CSSProperties = {
  borderColor: 'var(--dsw-alias-border-l3)',
  background: 'var(--dsw-alias-interactive-bg-hover)',
}

export const tasksBadgeInline: CSSProperties = {
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
