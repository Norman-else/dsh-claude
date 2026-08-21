import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClaudeClientProjection, ClaudeProjectionSource, ClaudeProjectionStore } from '../src/client/projection.ts'
import { createClaudeCommandSource, submitClaudeCommand } from '../src/client/claude-command-source.ts'

const projection: ClaudeClientProjection = {
  schemaVersion: 1,
  revision: 1,
  owned: true,
  commands: [{
    publicName: 'ci-deploy',
    claudeName: 'awesome-skills:ci-deploy',
    description: 'Deploy through CI',
    hint: '<env>',
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

describe('Claude client slash source', () => {
  it('discovers only commands owned by the current Claude session', async () => {
    const source = createClaudeCommandSource(store())
    await expect(source.candidates({ sessionId: 'session-1' } as never, {
      query: 'ci',
      position: 'leading',
      signal: new AbortController().signal,
    })).resolves.toEqual([{
      name: 'ci-deploy',
      description: 'Deploy through CI',
      hint: '<env>',
    }])
    await expect(createClaudeCommandSource(store({ ...projection, owned: false })).candidates(
      { sessionId: 'session-2' } as never,
      { query: '', position: 'leading', signal: new AbortController().signal },
    )).resolves.toEqual([])
  })

  it('submits the exact qualified Skill as an ordinary conversation message', async () => {
    const send = vi.fn(async () => undefined)
    const executeHostCommand = vi.fn()
    const actx = { conversation: { send }, executeHostCommand } as unknown as ClientContext

    await expect(submitClaudeCommand(projection.commands[0]!, 'sat', actx)).resolves.toEqual({ kind: 'success' })

    expect(send).toHaveBeenCalledWith('/awesome-skills:ci-deploy sat')
    expect(executeHostCommand).not.toHaveBeenCalled()
  })

  it('claims bare Enter and argument-bearing lines without executing on pick', async () => {
    const source = createClaudeCommandSource(store())
    const session = { sessionId: 'session-1' } as never
    const bare = await source.matchEnter?.(session, '/ci-deploy', new AbortController().signal)
    const argued = await source.matchEnter?.(session, '/ci-deploy sat', new AbortController().signal)
    const miss = await source.matchEnter?.(session, '/native-command', new AbortController().signal)

    expect(bare).toMatchObject({ claim: { token: '/ci-deploy ', hint: '<env>' } })
    expect(argued).toMatchObject({ claim: { token: '/ci-deploy ', hint: '<env>' } })
    expect(miss).toBeUndefined()
  })
})
