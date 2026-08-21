import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClaudeClientProjection, ClaudeProjectionSource, ClaudeProjectionStore } from '../src/client/projection.ts'
import { createClaudeCommandSource, submitClaudeCommand } from '../src/client/claude-command-source.ts'

const projection: ClaudeClientProjection = {
  schemaVersion: 1,
  revision: 1,
  owned: true,
  commands: [{
    publicName: 'agents-sdk',
    claudeName: 'agents-sdk',
    description: 'Build an agent',
    prefixed: false,
  }, {
    publicName: 'ci-deploy',
    claudeName: 'awesome-skills:ci-deploy',
    description: 'Deploy through CI',
    hint: '<env>',
    prefixed: false,
  }, {
    publicName: 'cloudflare',
    claudeName: 'cloudflare',
    description: 'Manage Cloudflare',
    prefixed: false,
  }],
  activities: [],
}

function store(value: ClaudeClientProjection = projection): ClaudeProjectionStore {
  const source: ClaudeProjectionSource = {
    getSnapshot: () => value,
    subscribe: () => () => {},
    dispose: () => {},
  }
  return { source: () => source, dispose: () => {} } as unknown as ClaudeProjectionStore
}

function context(send = vi.fn(async () => undefined)): { ctx: ClientContext; send: typeof send } {
  const sessionCtx = { sessionTag: 'session-1' }
  const ctx = {
    sessions: { scope: vi.fn(() => sessionCtx) },
    extend: vi.fn((meta: object) => ({ ...ctx, ...meta, conversation: { send } })),
  } as unknown as ClientContext
  return { ctx, send }
}

describe('Claude client slash source', () => {
  it('filters owned commands by the case-insensitive public-name query', async () => {
    const source = createClaudeCommandSource(context().ctx, store())
    const session = { sessionId: 'session-1' } as never
    const signal = new AbortController().signal

    await expect(source.candidates(session, {
      query: 'CI-',
      position: 'leading',
      signal,
    })).resolves.toEqual([{
      name: 'ci-deploy',
      description: 'Deploy through CI',
      hint: '<env>',
    }])
    await expect(source.candidates(session, {
      query: '',
      position: 'leading',
      signal,
    })).resolves.toHaveLength(3)
    await expect(source.candidates(session, {
      query: 'ci',
      position: 'embedded',
      signal,
    })).resolves.toEqual([])
    await expect(createClaudeCommandSource(context().ctx, store({ ...projection, owned: false })).candidates(
      { sessionId: 'session-2' } as never,
      { query: '', position: 'leading', signal },
    )).resolves.toEqual([])
  })

  it('submits the exact qualified Skill through the source-owned session scope', async () => {
    const { ctx, send } = context()
    const session = { sessionId: 'session-1' } as never

    await expect(submitClaudeCommand(ctx, session, projection.commands[1]!, 'sat')).resolves.toEqual({ kind: 'success' })

    expect(ctx.sessions.scope).toHaveBeenCalledWith('session-1')
    expect(ctx.extend).toHaveBeenCalledWith({ sessionTag: 'session-1' })
    expect(send).toHaveBeenCalledWith('/awesome-skills:ci-deploy sat')
  })

  it('combines the plugin fiber inject with the target session scope', async () => {
    const root = new Context()
    const send = vi.fn(async () => undefined)
    const conversationProvider = Object.assign(
      (ctx: Context) => ctx.provide('conversation', { send }),
      { provide: 'conversation' },
    )
    const conversationFiber = root.plugin(conversationProvider)
    await conversationFiber
    const sessionFiber = root.plugin(() => {})
    await sessionFiber
    const sessionCtx = sessionFiber.ctx.extend({ sessionTag: 'session-1' })
    root.provide('sessions', { scope: () => sessionCtx })
    let pluginCtx: ClientContext | undefined
    const plugin = Object.assign((ctx: ClientContext) => { pluginCtx = ctx }, {
      inject: ['conversation', 'sessions'],
    })
    const fiber = root.plugin(plugin)
    await fiber
    if (pluginCtx === undefined) throw new Error('plugin did not load')

    expect(() => sessionCtx.conversation).toThrow('without inject')
    await expect(submitClaudeCommand(
      pluginCtx,
      { sessionId: 'session-1' } as never,
      projection.commands[1]!,
      'sat',
    )).resolves.toEqual({ kind: 'success' })
    expect(send).toHaveBeenCalledWith('/awesome-skills:ci-deploy sat')
    await fiber.dispose()
    await sessionFiber.dispose()
    await conversationFiber.dispose()
  })

  it('claims bare Enter and submits without reading the input-trigger action context', async () => {
    const { ctx, send } = context()
    const source = createClaudeCommandSource(ctx, store())
    const session = { sessionId: 'session-1' } as never
    const bare = await source.matchEnter?.(session, '/ci-deploy', new AbortController().signal)
    const argued = await source.matchEnter?.(session, '/ci-deploy sat', new AbortController().signal)
    const miss = await source.matchEnter?.(session, '/native-command', new AbortController().signal)

    expect(bare).toMatchObject({ claim: { token: '/ci-deploy ', hint: '<env>' } })
    expect(argued).toMatchObject({ claim: { token: '/ci-deploy ', hint: '<env>' } })
    expect(miss).toBeUndefined()
    if (bare === undefined || bare === 'handled' || !('claim' in bare)) throw new Error('expected command claim')
    const actionContext = new Proxy({}, {
      get: () => { throw new Error('input-trigger context must not be read') },
    }) as ClientContext
    await expect(bare.claim.submit('sat', actionContext)).resolves.toEqual({ kind: 'success' })
    expect(send).toHaveBeenCalledWith('/awesome-skills:ci-deploy sat')
  })
})
