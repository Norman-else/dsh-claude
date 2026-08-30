import { describe, expect, it, vi } from 'vitest'
import { createClaudeDiagnosticsReporter, CLAUDE_DIAGNOSTICS_REPORT_CAP } from '../src/client/client-diagnostics.ts'

describe('Claude client diagnostics reporter', () => {
  it('forwards one report to the Host', () => {
    const post = vi.fn()
    createClaudeDiagnosticsReporter(post).report('slot-entry-crashed', 'boom')
    expect(post).toHaveBeenCalledWith({ kind: 'slot-entry-crashed', detail: 'boom' })
  })

  // A crashing Slot entry re-renders on every store notification, so an
  // un-deduplicated reporter would turn one bug into an endless log.
  it('sends a repeated report only once', () => {
    const post = vi.fn()
    const reporter = createClaudeDiagnosticsReporter(post)
    reporter.report('slot-entry-crashed', 'boom')
    reporter.report('slot-entry-crashed', 'boom')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps reports that differ in kind or detail apart', () => {
    const post = vi.fn()
    const reporter = createClaudeDiagnosticsReporter(post)
    reporter.report('slot-entry-crashed', 'boom')
    reporter.report('slot-entry-crashed', 'other')
    reporter.report('boot-check', 'boom')
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('stops after the cap so a render loop cannot flood the Host log', () => {
    const post = vi.fn()
    const reporter = createClaudeDiagnosticsReporter(post)
    for (let index = 0; index <= CLAUDE_DIAGNOSTICS_REPORT_CAP; index += 1) {
      reporter.report('slot-entry-crashed', `boom-${index}`)
    }
    expect(post).toHaveBeenCalledTimes(CLAUDE_DIAGNOSTICS_REPORT_CAP)
  })

  it('never lets a failing transport reach the caller', () => {
    const reporter = createClaudeDiagnosticsReporter(() => { throw new Error('offline') })
    expect(() => { reporter.report('boot-check', 'boom') }).not.toThrow()
  })
})
