import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseAfterSubmission, retainForHandoff } from '../src/client/session-handoff.ts'

function session(initial: { running?: boolean; pendingSubmissions?: readonly unknown[] }) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: typeof initial) { snapshot = next; for (const listener of [...listeners]) listener() },
    listeners,
  }
}

function reference(state: ReturnType<typeof session>) {
  return { sessionId: 'session-1', binding: { session: state }, ready: Promise.resolve(), release: vi.fn() } as never as {
    release: ReturnType<typeof vi.fn>
  } & Parameters<typeof releaseAfterSubmission>[0]
}

describe('worktree session hand-off', () => {
  afterEach(() => { vi.useRealTimers() })

  it('retains the new Session under its own source and waits for it to open', async () => {
    const ref = { ready: Promise.resolve(), release: vi.fn() }
    const retain = vi.fn(() => ref)
    await expect(retainForHandoff({ retain } as never, 'session-1' as never)).resolves.toBe(ref)
    expect(retain).toHaveBeenCalledWith('session-1', { source: 'claudeWorktreeHandoff' })
  })

  it('drops the hold when the Session never opens', async () => {
    const ref = { ready: Promise.reject(new Error('open failed')), release: vi.fn() }
    await expect(retainForHandoff({ retain: () => ref } as never, 'session-1' as never)).rejects.toThrow('open failed')
    expect(ref.release).toHaveBeenCalledOnce()
  })

  it('keeps the hold while the submission is still in flight', () => {
    // Releasing the last reference tears the scope down and aborts the send.
    const state = session({ running: false, pendingSubmissions: [{}] })
    const ref = reference(state)
    releaseAfterSubmission(ref)
    expect(ref.release).not.toHaveBeenCalled()
    state.set({ running: false, pendingSubmissions: [] })
    expect(ref.release).toHaveBeenCalledOnce()
    expect(state.listeners.size).toBe(0)
  })

  it('releases once the turn starts running', () => {
    const state = session({ running: false, pendingSubmissions: [] })
    const ref = reference(state)
    releaseAfterSubmission(ref)
    expect(ref.release).not.toHaveBeenCalled()
    state.set({ running: true, pendingSubmissions: [] })
    expect(ref.release).toHaveBeenCalledOnce()
  })

  it('releases after the timeout when the Host reports nothing', () => {
    vi.useFakeTimers()
    const ref = reference(session({ running: false, pendingSubmissions: [] }))
    releaseAfterSubmission(ref, 1_000)
    vi.advanceTimersByTime(999)
    expect(ref.release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(ref.release).toHaveBeenCalledOnce()
  })
})
