import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopClaudeTask } from '../src/client/task-api.ts'
import { __resetPluginTransport, __setPluginFetch } from '../src/client/plugin-transport.ts'

afterEach(() => {
  // Module-level transport state: a permit left held here starves the next case.
  __resetPluginTransport()
})

describe('task client API', () => {
  it('posts the session and task to the stop route', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    __setPluginFetch(fetch as unknown as typeof fetch)
    await expect(stopClaudeTask('session-1', 'task-1')).resolves.toBeUndefined()
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/plugins/dsh-claude/tasks/stop')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(init.body).toBe(JSON.stringify({ sessionId: 'session-1', taskId: 'task-1' }))
  })

  it('reports the refusal the route gave, and a missing route as such', async () => {
    __setPluginFetch(vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'task-unavailable' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch)
    await expect(stopClaudeTask('session-1', 'task-1')).rejects.toThrow('task-unavailable')

    // A Host still running the previously loaded bundle has no such route.
    __setPluginFetch(vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not-found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch)
    await expect(stopClaudeTask('session-1', 'task-1')).rejects.toThrow('route-missing')
  })
})
