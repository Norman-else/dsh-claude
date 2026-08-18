import type { CSSProperties } from 'react'

export const shell: CSSProperties = {
  marginTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-label-secondary)',
}

export const summary: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 34,
  cursor: 'pointer',
  listStyle: 'none',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary)',
  userSelect: 'none',
}

export const countBadge: CSSProperties = {
  padding: '1px 7px',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
}

export const activityList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  padding: '2px 0 8px 2px',
}

export const activityRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '18px minmax(0, 1fr)',
  gap: 8,
  position: 'relative',
  padding: '6px 0',
}

export const rail: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '18px',
}

export const rowTitle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '18px',
  fontWeight: 500,
  overflowWrap: 'anywhere',
}

export const rowSummary: CSSProperties = {
  margin: '2px 0 0',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
  lineHeight: '17px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

export const detailSummary: CSSProperties = {
  marginTop: 4,
  cursor: 'pointer',
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
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
