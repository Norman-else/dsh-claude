import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ExecutableRuntime } from '../src/executable.ts'
import type { ClaudeSupervisor } from '../src/supervisor.ts'
import { CLAUDE_DOCTOR_PATH } from '../src/constants.ts'
import { registerClaudeDoctorRoutes } from '../src/doctor-routes.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

interface Captured {
  handler: Handler
}

function context(): Context & { captured: Captured } {
  const captured: Captured = { handler: async () => {} }
  return {
    captured,
    effect: (register: () => unknown) => {
      const dispose = register() as Captured
      captured.handler = dispose.handler
    },
    webServer: {
      register: (route: Captured & { path: string }) => {
        expect(route.path).toBe(CLAUDE_DOCTOR_PATH)
        return route
      },
    },
  } as unknown as Context & { captured: Captured }
}

function response() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status },
    end(body: string) { this.body = body },
  } as unknown as ServerResponse & { statusCode: number; body: string }
}

function request(headers: Record<string, string>): IncomingMessage {
  return {
    method: 'GET',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

const runtime = {
  resolveExecutable: vi.fn(async () => { throw new Error('must not probe again') }),
  spawn: vi.fn(),
} as unknown as ExecutableRuntime

const supervisor = { snapshots: () => [] } as unknown as ClaudeSupervisor

describe('Claude Doctor Web route', () => {
  it('returns a missing-executable diagnosis without starting the provider', async () => {
    const ctx = context()
    registerClaudeDoctorRoutes(ctx, runtime, supervisor, {
      executablePath: '',
      defaultModel: 'default',
      idleTimeoutMs: 1_000,
      maxProcesses: 4,
    }, new Error('Claude Code executable not found'))
    const res = response()
    await ctx.captured.handler(request({ host: 'localhost:56454' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      executable: { status: 'missing' },
      version: { status: 'not-run' },
      authentication: { status: 'not-run' },
      processes: { count: 0, active: 0 },
    })
  })

  it('rejects attacker-controlled Host/Origin combinations', async () => {
    const ctx = context()
    registerClaudeDoctorRoutes(ctx, runtime, supervisor, {
      executablePath: '',
      defaultModel: 'default',
      idleTimeoutMs: 1_000,
      maxProcesses: 4,
    }, new Error('Claude Code executable not found'))
    for (const headers of [
      { host: 'rebinding.example:56454', origin: 'http://rebinding.example:56454' },
      { host: 'localhost:56454', origin: 'http://rebinding.example:56454' },
      { host: '127.0.0.1:56454', origin: 'https://attacker.test' },
    ]) {
      const res = response()
      await ctx.captured.handler(request(headers), res)
      expect(res.statusCode).toBe(403)
    }
  })
})
