import { describe, expect, it, vi } from 'vitest'
import { latestPlanUsage, normalizePlanUsage, recordPlanUsage, resetPlanUsage } from '../src/plan-usage.ts'
import { registerPlanUsageRoute } from '../src/plan-usage-routes.ts'
import { CLAUDE_USAGE_PATH } from '../src/constants.ts'

const SDK_RESPONSE = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 41.6, resets_at: '2026-08-27T12:00:00Z' },
    seven_day: { utilization: 88, resets_at: '2026-09-01T00:00:00Z' },
    seven_day_oauth_apps: { utilization: 3, resets_at: '2026-09-01T00:00:00Z' },
    model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: '2026-09-01T00:00:00Z' }],
  },
}

describe('normalizePlanUsage', () => {
  it('projects the five hour, weekly, and per-model windows', () => {
    const report = normalizePlanUsage(SDK_RESPONSE, 1_000)
    expect(report.available).toBe(true)
    expect(report.subscription).toBe('max')
    expect(report.fetchedAt).toBe(1_000)
    expect(report.windows).toEqual([
      { id: 'five_hour', utilization: 41.6, resetsAt: '2026-08-27T12:00:00Z' },
      { id: 'seven_day', utilization: 88, resetsAt: '2026-09-01T00:00:00Z' },
      { id: 'model:Fable', label: 'Fable', utilization: 12, resetsAt: '2026-09-01T00:00:00Z' },
    ])
  })

  it('reports unavailable for API key and third-party provider sessions', () => {
    expect(normalizePlanUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }, 5).windows).toEqual([])
    expect(normalizePlanUsage({ rate_limits_available: false, rate_limits: null }, 5).available).toBe(false)
  })

  it('survives a shape change instead of throwing', () => {
    for (const value of [undefined, null, 'nope', 42, [], { rate_limits_available: true, rate_limits: 'moved' }]) {
      expect(normalizePlanUsage(value, 7)).toEqual({ available: false, windows: [], fetchedAt: 7 })
    }
  })

  it('clamps utilization and drops windows carrying no numbers at all', () => {
    const report = normalizePlanUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 143, resets_at: null },
        seven_day: { utilization: -8, resets_at: null },
        seven_day_opus: { utilization: null, resets_at: null },
      },
    }, 0)
    expect(report.windows).toEqual([
      { id: 'five_hour', utilization: 100 },
      { id: 'seven_day', utilization: 0 },
    ])
  })
})

describe('plan usage route', () => {
  function harness(
    agents: readonly { id: string }[],
    options: { states?: Record<string, string>; planUsage?: ReturnType<typeof vi.fn> } = {},
  ) {
    const planUsage = options.planUsage ?? vi.fn(async () => SDK_RESPONSE)
    const snapshots = vi.fn(() => Object.entries(options.states ?? {}).map(([sessionId, state]) => ({ sessionId, state })))
    let handler!: (req: unknown, res: unknown) => Promise<void>
    const ctx = {
      effect: (setup: () => unknown) => { setup() },
      webServer: { register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } },
    } as unknown as Parameters<typeof registerPlanUsageRoute>[0]
    registerPlanUsageRoute(ctx, { planUsage, snapshots } as never, () => agents as never, () => 4_242)
    return { handler, planUsage }
  }

  function busyError(): Error {
    const error = new Error('Claude Code session s1 already has an active or interrupting turn')
    error.name = 'ClaudeTurnBusyError'
    return error
  }

  function call(handler: (req: unknown, res: unknown) => Promise<void>, method: string) {
    let status = 0
    let body: unknown
    const res = { writeHead: (code: number) => { status = code }, end: (text: string) => { body = JSON.parse(text) } }
    const req = { method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1234' } }
    return handler(req, res).then(() => ({ status, body }))
  }

  it('serves the cached report on GET and refreshes it on POST', async () => {
    resetPlanUsage()
    const { handler, planUsage } = harness([{ id: 'agent-1' }])

    expect(await call(handler, 'GET')).toEqual({ status: 200, body: { available: false, windows: [], fetchedAt: 0 } })
    expect(planUsage).not.toHaveBeenCalled()

    const refreshed = await call(handler, 'POST')
    expect(planUsage).toHaveBeenCalledTimes(1)
    expect(refreshed.status).toBe(200)
    expect((refreshed.body as { fetchedAt: number }).fetchedAt).toBe(4_242)
    expect(latestPlanUsage()?.windows).toHaveLength(3)

    // The cache now backs plain GETs without another SDK round trip.
    expect(await call(handler, 'GET')).toEqual({ status: 200, body: latestPlanUsage() })
    expect(planUsage).toHaveBeenCalledTimes(1)
  })

  it('flags a refresh with no live Claude session instead of failing', async () => {
    resetPlanUsage()
    recordPlanUsage({ available: true, windows: [{ id: 'five_hour', utilization: 10 }], fetchedAt: 99 })
    const { handler, planUsage } = harness([])
    expect(await call(handler, 'POST')).toEqual({
      status: 200,
      body: { available: true, windows: [{ id: 'five_hour', utilization: 10 }], fetchedAt: 99, message: 'no-session' },
    })
    expect(planUsage).not.toHaveBeenCalled()
  })

  it('skips sessions that are mid-turn and picks an idle one', async () => {
    resetPlanUsage()
    const { handler, planUsage } = harness(
      [{ id: 'busy-session' }, { id: 'idle-session' }],
      { states: { 'busy-session': 'running', 'idle-session': 'idle' } },
    )
    expect((await call(handler, 'POST')).status).toBe(200)
    expect(planUsage).toHaveBeenCalledTimes(1)
    expect((planUsage.mock.calls[0] as unknown[])[0]).toEqual({ id: 'idle-session' })
  })

  it('reports busy instead of failing when every session is mid-turn', async () => {
    resetPlanUsage()
    recordPlanUsage({ available: true, windows: [{ id: 'five_hour', utilization: 31 }], fetchedAt: 7 })
    const { handler, planUsage } = harness([{ id: 's1' }], { states: { s1: 'running' } })
    expect(await call(handler, 'POST')).toEqual({
      status: 200,
      body: { available: true, windows: [{ id: 'five_hour', utilization: 31 }], fetchedAt: 7, message: 'busy' },
    })
    expect(planUsage).not.toHaveBeenCalled()
  })

  it('treats a turn starting mid-request as busy rather than a 500', async () => {
    resetPlanUsage()
    recordPlanUsage({ available: true, windows: [], fetchedAt: 3 })
    // Idle at pick time, busy by the time the control request lands.
    const { handler } = harness([{ id: 's1' }], {
      states: { s1: 'idle' },
      planUsage: vi.fn(async () => { throw busyError() }),
    })
    const raced = await call(handler, 'POST')
    expect(raced.status).toBe(200)
    expect((raced.body as { message?: string }).message).toBe('busy')
  })

  it('rejects other methods and non-loopback callers', async () => {
    resetPlanUsage()
    const { handler } = harness([{ id: 'agent-1' }])
    expect((await call(handler, 'DELETE')).status).toBe(405)
    let status = 0
    await handler(
      { method: 'GET', socket: { remoteAddress: '10.0.0.4' }, headers: { host: 'example.com' } },
      { writeHead: (code: number) => { status = code }, end: () => {} },
    )
    expect(status).toBe(403)
  })

  it('reports an SDK failure as a 500 and leaves the cache untouched', async () => {
    resetPlanUsage()
    recordPlanUsage({ available: true, windows: [], fetchedAt: 12 })
    const { handler } = harness([{ id: 'agent-1' }], { planUsage: vi.fn(async () => { throw new Error('no plan usage API') }) })
    const failed = await call(handler, 'POST')
    expect(failed.status).toBe(500)
    expect(latestPlanUsage()?.fetchedAt).toBe(12)
  })
})
