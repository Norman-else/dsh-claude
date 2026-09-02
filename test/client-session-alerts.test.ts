import { describe, expect, it } from 'vitest'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import {
  sessionAlert,
  setClaudeAlertsEnabled,
  startClaudeSessionAlerts,
  type ClaudeSessionAlert,
  type ClaudeSessionAlertsDeps,
} from '../src/client/session-alerts.ts'

function permissionActivity(phase: 'started' | 'completed'): ClaudeActivityEvent {
  return { turn: 1, step: 1, ordinal: 1, kind: 'permission', phase }
}

interface Row {
  id: string
  displayTitle?: string
  cwd?: string
  agentPreset?: string
  running?: boolean
}

/** A session list and a projection per session, both hand-driven. */
function harness(rows: Row[], current?: string) {
  const listeners = new Set<() => void>()
  const projectionListeners = new Map<string, Set<() => void>>()
  const activities = new Map<string, readonly ClaudeActivityEvent[]>()
  const posted: ClaudeSessionAlert[] = []
  const state = {
    rows,
    current,
    notify(): void { for (const listener of [...listeners]) listener() },
    setActivities(sessionId: string, next: readonly ClaudeActivityEvent[]): void {
      activities.set(sessionId, next)
      for (const listener of [...projectionListeners.get(sessionId) ?? []]) listener()
    },
    posted,
  }
  const deps: ClaudeSessionAlertsDeps = {
    sessions: {
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      getSnapshot: () => ({
        ids: state.rows.map(row => row.id),
        byId: Object.fromEntries(state.rows.map(row => [row.id, { agentPreset: 'claude', cwd: '/repo', ...row }])),
        ...(state.current === undefined ? {} : { current: state.current }),
      }),
    },
    projectionFor: sessionId => ({
      subscribe: listener => {
        let set = projectionListeners.get(sessionId)
        if (set === undefined) { set = new Set(); projectionListeners.set(sessionId, set) }
        set.add(listener)
        return () => set.delete(listener)
      },
      getSnapshot: (): ClaudeClientProjection => ({
        ...EMPTY_CLAUDE_PROJECTION,
        owned: true,
        activities: activities.get(sessionId) ?? [],
      }),
    }),
    open: () => {},
    t: key => key,
    enabled: () => true,
    post: alert => { posted.push(alert) },
  }
  return { state, deps }
}

describe('session alert decisions', () => {
  it('says nothing about a session it is seeing for the first time', () => {
    // A restart would otherwise announce every session's standing state at once.
    expect(sessionAlert(undefined, { running: true, attention: 'permission' })).toBeUndefined()
    expect(sessionAlert(undefined, { running: false, attention: undefined })).toBeUndefined()
  })

  it('announces a new prompt, once', () => {
    const waiting = { running: true, attention: 'permission' } as const
    expect(sessionAlert({ running: true, attention: undefined }, waiting)).toBe('permission')
    // The same prompt, still open, has already been announced.
    expect(sessionAlert(waiting, waiting)).toBeUndefined()
    // A question after an approval is a different prompt.
    expect(sessionAlert(waiting, { running: true, attention: 'question' })).toBe('question')
  })

  it('announces a turn that finished', () => {
    expect(sessionAlert({ running: true, attention: undefined }, { running: false, attention: undefined })).toBe('idle')
    // An idle session that stays idle is not news.
    expect(sessionAlert({ running: false, attention: undefined }, { running: false, attention: undefined })).toBeUndefined()
  })
})

describe('session alert watcher', () => {
  it('alerts on a background session and stays quiet about the one on screen', () => {
    const { state, deps } = harness([
      { id: 'visible', displayTitle: 'On screen', running: true },
      { id: 'background', displayTitle: 'Elsewhere', running: true },
    ], 'visible')
    const stop = startClaudeSessionAlerts(deps)
    try {
      state.setActivities('visible', [permissionActivity('started')])
      state.setActivities('background', [permissionActivity('started')])
      expect(state.posted.map(alert => alert.sessionId)).toEqual(['background'])
      expect(state.posted[0]).toMatchObject({ title: 'Elsewhere', body: 'alertNeedsPermission' })

      // Answering it, then finishing the turn, is one more alert -- not two.
      state.setActivities('background', [permissionActivity('completed')])
      state.rows = state.rows.map(row => (row.id === 'background' ? { ...row, running: false } : row))
      state.notify()
      expect(state.posted.map(alert => alert.body)).toEqual(['alertNeedsPermission', 'alertTurnFinished'])
    } finally {
      stop()
    }
  })

  it('honours the setting at delivery time', () => {
    const { state, deps } = harness([{ id: 'background', running: true }])
    const { enabled: _ignored, ...withoutOverride } = deps
    setClaudeAlertsEnabled(false)
    const stop = startClaudeSessionAlerts(withoutOverride)
    try {
      state.setActivities('background', [permissionActivity('started')])
      expect(state.posted).toEqual([])
      setClaudeAlertsEnabled(true)
      state.setActivities('background', [{ ...permissionActivity('started'), kind: 'question' }])
      expect(state.posted.map(alert => alert.body)).toEqual(['alertNeedsAnswer'])
    } finally {
      stop()
      setClaudeAlertsEnabled(true)
    }
  })

  it('forgets a session that leaves the list', () => {
    const { state, deps } = harness([{ id: 'gone', running: true }])
    const stop = startClaudeSessionAlerts(deps)
    try {
      state.setActivities('gone', [permissionActivity('started')])
      expect(state.posted).toHaveLength(1)
      state.rows = []
      state.notify()
      // Back with the same prompt still open: a reload is not a new prompt for
      // a session this watcher has never seen before.
      state.rows = [{ id: 'gone', running: true }]
      state.notify()
      expect(state.posted).toHaveLength(1)
    } finally {
      stop()
    }
  })
})
