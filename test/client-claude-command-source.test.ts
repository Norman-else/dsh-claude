import { describe, expect, it, vi } from 'vitest'
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

describe('Claude client slash source', () => {
  it('filters owned commands by the case-insensitive public-name query', async () => {
    const source = createClaudeCommandSource(store())
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
    await expect(createClaudeCommandSource(store({ ...projection, owned: false })).candidates(
      { sessionId: 'session-2' } as never,
      { query: '', position: 'leading', signal },
    )).resolves.toEqual([])
  })

  it('submits the exact qualified Skill as an ordinary conversation message', async () => {
    const send = vi.fn(async () => undefined)
    const executeHostCommand = vi.fn()
    const actx = { conversation: { send }, executeHostCommand } as unknown as ClientContext

    await expect(submitClaudeCommand(projection.commands[1]!, 'sat', actx)).resolves.toEqual({ kind: 'success' })

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
