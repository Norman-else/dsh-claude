import { describe, expect, it } from 'vitest'
import { SessionRootLedger } from '../src/session-root-ledger.ts'

describe('session root ledger', () => {
  it('authorises a root the session has ever vouched for, tolerating a transient probe that drops it', () => {
    const ledger = new SessionRootLedger(32)
    ledger.vouch('s', ['/a', '/b'])
    expect(ledger.allows('s', '/a')).toBe(true)
    expect(ledger.allows('s', '/b')).toBe(true)
    // A sweep whose gh/git probe failed returns fewer roots; the bar the client
    // still shows must stay actionable.
    ledger.vouch('s', ['/a'])
    expect(ledger.allows('s', '/b')).toBe(true)
    // Never vouched, and cross-session.
    expect(ledger.allows('s', '/c')).toBe(false)
    expect(ledger.allows('other', '/a')).toBe(false)
  })

  it('bounds how many roots one session can accumulate, dropping the oldest', () => {
    const ledger = new SessionRootLedger(2)
    ledger.vouch('s', ['/a'])
    ledger.vouch('s', ['/b'])
    ledger.vouch('s', ['/c'])
    expect(ledger.allows('s', '/a')).toBe(false)
    expect(ledger.allows('s', '/b')).toBe(true)
    expect(ledger.allows('s', '/c')).toBe(true)
  })

  it('forgets a session', () => {
    const ledger = new SessionRootLedger(32)
    ledger.vouch('s', ['/a'])
    ledger.forget('s')
    expect(ledger.allows('s', '/a')).toBe(false)
  })
})
