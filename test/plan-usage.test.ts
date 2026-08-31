import { describe, expect, it, vi } from 'vitest'
import { PLAN_USAGE_TIMEOUT_MS, latestPlanUsage, normalizePlanUsage, probePlanUsage, recordPlanUsage, resetPlanUsage } from '../src/plan-usage.ts'
import { registerPlanUsageRoute } from '../src/plan-usage-routes.ts'

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

describe('probePlanUsage', () => {
  function fakeQuery(overrides: Record<string, unknown> = {}) {
    return {
      async *[Symbol.asyncIterator]() { await new Promise<never>(() => {}) },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => SDK_RESPONSE),
      ...overrides,
    }
  }

  it('gives up on a control request that never answers', async () => {
    vi.useFakeTimers()
    try {
      const query = fakeQuery({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(() => new Promise<never>(() => {})),
      })
      let options!: { abortController?: AbortController }
      const probe = probePlanUsage('/opt/claude', 1, params => {
        options = params.options as typeof options
        return query as never
      })
      const settled = expect(probe).rejects.toThrow('did not answer in time')
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_TIMEOUT_MS)
      await settled
      expect(options.abortController?.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs a throwaway query and tears the process down afterwards', async () => {
    let options!: { abortController?: AbortController; pathToClaudeCodeExecutable?: string }
    const query = fakeQuery()
    const report = await probePlanUsage('/opt/claude', 88, params => {
      options = params.options as typeof options
      return query as never
    })
    expect(report.windows).toHaveLength(3)
    expect(report.fetchedAt).toBe(88)
    expect(options.pathToClaudeCodeExecutable).toBe('/opt/claude')
    // Nothing may outlive the single control request.
    expect(options.abortController?.signal.aborted).toBe(true)
  })

  it('lets the SDK resolve the executable when none is configured', async () => {
    let options!: Record<string, unknown>
    await probePlanUsage('', 1, params => {
      options = params.options as Record<string, unknown>
      return fakeQuery() as never
    })
    expect('pathToClaudeCodeExecutable' in options).toBe(false)
  })

  it('aborts the probe when the SDK build has no usage API', async () => {
    let options!: { abortController?: AbortController }
    await expect(probePlanUsage('/opt/claude', 1, params => {
      options = params.options as typeof options
      return fakeQuery({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: undefined }) as never
    })).rejects.toThrow('no plan usage API')
    expect(options.abortController?.signal.aborted).toBe(true)
  })
})

describe('plan usage route', () => {
  type Handler = (req: unknown, res: unknown) => Promise<void>

  function harness(probe = vi.fn(async (fetchedAt: number) => normalizePlanUsage(SDK_RESPONSE, fetchedAt))) {
    let handler!: Handler
    const ctx = {
      effect: (setup: () => unknown, _label?: string) => { setup() },
      webServer: { register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
    } as unknown as Parameters<typeof registerPlanUsageRoute>[0]
    registerPlanUsageRoute(ctx, probe, () => 4_242)
    return { handler, probe }
  }

  // registerPluginRoute writes through the ServerResponse itself and attaches
  // disconnect teardown before its first await, so the fake has to carry the
  // listener and write surface even when a case never disconnects.
  function response() {
    return {
      status: 0,
      body: undefined as unknown,
      headersSent: false,
      writableEnded: false,
      on() { return this },
      write() { return true },
      writeHead(code: number) { this.status = code; this.headersSent = true; return this },
      end(text?: string) { this.writableEnded = true; if (text !== undefined) this.body = JSON.parse(text) },
    }
  }

  function call(handler: Handler, method: string, remoteAddress = '127.0.0.1', host = '127.0.0.1:1234') {
    const res = response()
    const req = { method, socket: { remoteAddress }, headers: { host }, on() { return this } }
    return handler(req, res).then(() => ({ status: res.status, body: res.body }))
  }

  it('serves the cached report on GET and probes on POST', async () => {
    resetPlanUsage()
    const { handler, probe } = harness()

    expect(await call(handler, 'GET')).toEqual({ status: 200, body: { available: false, windows: [], fetchedAt: 0 } })
    expect(probe).not.toHaveBeenCalled()

    const refreshed = await call(handler, 'POST')
    expect(probe).toHaveBeenCalledWith(4_242)
    expect(refreshed.status).toBe(200)
    expect((refreshed.body as { fetchedAt: number }).fetchedAt).toBe(4_242)
    expect(latestPlanUsage()?.windows).toHaveLength(3)

    // The cache now backs plain GETs without another probe process.
    expect(await call(handler, 'GET')).toEqual({ status: 200, body: latestPlanUsage() })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('rejects other methods and non-loopback callers', async () => {
    resetPlanUsage()
    const { handler } = harness()
    expect((await call(handler, 'DELETE')).status).toBe(405)
    expect((await call(handler, 'GET', '10.0.0.4', 'example.com')).status).toBe(403)
  })

  it('reports a probe failure as a 500 and leaves the cache untouched', async () => {
    resetPlanUsage()
    recordPlanUsage({ available: true, windows: [], fetchedAt: 12 })
    const { handler } = harness(vi.fn(async () => { throw new Error('claude executable not found') }))
    const failed = await call(handler, 'POST')
    expect(failed.status).toBe(500)
    expect(latestPlanUsage()?.fetchedAt).toBe(12)
  })
})
