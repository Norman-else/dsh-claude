import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PlanUsageMeter, durationLabel, isPlanUsageReport } from '../src/client/ClaudeCodeSettings.tsx'
import { en } from '../src/client/locales.ts'
import type { ClaudeCodeSettingsKey } from '../src/client/locales.ts'

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  Object.entries(params ?? {}).reduce<string>(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key] as string,
  )

const NOW = Date.parse('2026-08-27T10:00:00Z')

describe('durationLabel', () => {
  it('drops to minutes under an hour and clamps a passed deadline', () => {
    expect(durationLabel(45 * 60_000)).toBe('45m')
    expect(durationLabel(-90 * 60_000)).toBe('0m')
    expect(durationLabel(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m')
    expect(durationLabel(3 * 3_600_000)).toBe('3h')
    expect(durationLabel(50 * 3_600_000)).toBe('2d')
  })
})

describe('isPlanUsageReport', () => {
  it('accepts the server shape and rejects everything else', () => {
    expect(isPlanUsageReport({ available: true, windows: [{ id: 'five_hour' }], fetchedAt: 1 })).toBe(true)
    expect(isPlanUsageReport({ available: true, windows: [{}], fetchedAt: 1 })).toBe(false)
    expect(isPlanUsageReport({ available: true, fetchedAt: 1 })).toBe(false)
    expect(isPlanUsageReport(null)).toBe(false)
    expect(isPlanUsageReport([])).toBe(false)
  })
})

describe('PlanUsageMeter', () => {
  const render = (window: Parameters<typeof PlanUsageMeter>[0]['window']): string =>
    renderToStaticMarkup(<PlanUsageMeter window={window} t={t} now={NOW} />)

  it('draws the bar to the utilization and counts down to the reset', () => {
    const markup = render({ id: 'five_hour', utilization: 41.6, resetsAt: '2026-08-27T12:14:00Z' })
    expect(markup).toContain('width:41.6%')
    expect(markup).toContain('42% used')
    expect(markup).toContain('Resets in 2h 14m')
  })

  it('paints the fill as a block so its width actually applies', () => {
    // A span defaults to display:inline, where width is ignored entirely.
    expect(render({ id: 'five_hour', utilization: 41.6 })).toContain('display:block')
  })

  it('escalates the tone as a window fills', () => {
    const quiet = render({ id: 'five_hour', utilization: 50 })
    expect(quiet).toContain('--dsw-static-blue-450')
    expect(quiet).not.toContain('state-warning')
    expect(quiet).not.toContain('state-error')
    expect(render({ id: 'five_hour', utilization: 80 })).toContain('state-warning')
    const critical = render({ id: 'seven_day', utilization: 95 })
    expect(critical).toContain('state-error')
    expect(critical).not.toContain('--dsw-static-blue-450')
  })

  it('renders an empty bar when the server sends no number', () => {
    const markup = render({ id: 'seven_day' })
    expect(markup).toContain('width:0%')
    expect(markup).toContain('background:transparent')
    expect(markup).toContain('—')
    expect(markup).not.toContain('Resets in')
  })
})
