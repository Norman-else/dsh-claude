import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { ClaudeCommandBridge } from '../src/command-bridge.ts'

function target(reserved: string[] = []) {
  const definitions = new Map<string, CommandDefinition>()
  const forward = vi.fn()
  const disposed: string[] = []
  return {
    definitions,
    forward,
    disposed,
    value: {
      list: () => [
        ...reserved.map(name => ({ name })),
        ...[...definitions.keys()].map(name => ({ name })),
      ],
      register: (definition: CommandDefinition) => {
        if (definitions.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
        definitions.set(definition.name, definition)
        return () => {
          definitions.delete(definition.name)
          disposed.push(definition.name)
        }
      },
      forward,
    },
  }
}

const catalog = [{
  name: 'review',
  description: 'Review current changes',
  argumentHint: '<path>',
  aliases: ['inspect'],
}]

describe('Claude command bridge', () => {
  it('registers native command names and aliases with their argument hints', () => {
    const owner = target()
    const bridge = new ClaudeCommandBridge(owner.value)
    expect(bridge.refresh(catalog)).toEqual([
      { publicName: 'review', claudeName: 'review', prefixed: false },
      { publicName: 'inspect', claudeName: 'inspect', prefixed: false },
    ])
    expect(owner.definitions.get('review')).toMatchObject({
      name: 'review',
      description: 'Review current changes',
      input: { hint: '<path>' },
      recordInput: false,
    })
  })

  it('keeps DSH names authoritative and prefixes only conflicting Claude commands', () => {
    const owner = target(['compact'])
    const bridge = new ClaudeCommandBridge(owner.value)
    expect(bridge.refresh([{
      name: 'compact',
      description: 'Claude compact',
      argumentHint: '',
    }])).toEqual([
      { publicName: 'claude-compact', claudeName: 'compact', prefixed: true },
    ])
    expect(owner.definitions.has('compact')).toBe(false)
    expect(owner.definitions.has('claude-compact')).toBe(true)
  })

  it('prefixes names owned by client-side commandUi contributions', () => {
    // A host command named "model" collides with the client /model
    // contribution and the web palette drops its entire command group.
    const owner = target()
    const bridge = new ClaudeCommandBridge(owner.value)
    expect(bridge.refresh([{
      name: 'model',
      description: 'Claude model picker',
      argumentHint: '',
    }])).toEqual([
      { publicName: 'claude-model', claudeName: 'model', prefixed: true },
    ])
    expect(owner.definitions.has('model')).toBe(false)
    expect(owner.definitions.has('claude-model')).toBe(true)
  })

  it('forwards the exact Claude slash line through the receiving DSH agent', async () => {
    const owner = target()
    const bridge = new ClaudeCommandBridge(owner.value)
    const receivingAgent = { id: 'receiving-session' } as Agent
    bridge.refresh(catalog)
    await owner.definitions.get('review')!.handler({ agent: receivingAgent, rawInput: ' src/index.ts' } as never)
    await owner.definitions.get('inspect')!.handler({ agent: receivingAgent, rawInput: '' } as never)
    expect(owner.forward).toHaveBeenNthCalledWith(1, receivingAgent, '/review src/index.ts')
    expect(owner.forward).toHaveBeenNthCalledWith(2, receivingAgent, '/inspect')
  })

  it('drops invalid names and skips a second prefixed collision', () => {
    const owner = target(['bad', 'claude-bad'])
    const bridge = new ClaudeCommandBridge(owner.value)
    expect(bridge.refresh([
      { name: 'Bad Name', description: 'invalid', argumentHint: '' },
      { name: 'bad', description: 'collides twice', argumentHint: '' },
    ])).toEqual([])
    expect(owner.definitions.size).toBe(0)
  })

  it('registers plugin-qualified skills by their short name and forwards the qualified line', async () => {
    const owner = target()
    const bridge = new ClaudeCommandBridge(owner.value)
    expect(bridge.refresh([{
      name: 'awesome-skills:ci-deploy',
      description: 'Deploy through CI',
      argumentHint: '<env>',
    }])).toEqual([
      { publicName: 'ci-deploy', claudeName: 'awesome-skills:ci-deploy', prefixed: false },
    ])
    const receivingAgent = { id: 'receiving-session' } as Agent
    await owner.definitions.get('ci-deploy')!.handler({ agent: receivingAgent, rawInput: ' sat' } as never)
    expect(owner.forward).toHaveBeenCalledWith(receivingAgent, '/awesome-skills:ci-deploy sat')
  })

  it('prefixes a qualified skill whose short name is already reserved', () => {
    const owner = target(['ci-deploy'])
    const bridge = new ClaudeCommandBridge(owner.value)
    expect(bridge.refresh([{
      name: 'awesome-skills:ci-deploy',
      description: 'Deploy through CI',
      argumentHint: '',
    }])).toEqual([
      { publicName: 'claude-ci-deploy', claudeName: 'awesome-skills:ci-deploy', prefixed: true },
    ])
  })

  it('reconciles changed catalogs and disposes every scoped registration', () => {
    const owner = target()
    const bridge = new ClaudeCommandBridge(owner.value)
    bridge.refresh(catalog)
    bridge.refresh([{ name: 'test', description: 'Run tests', argumentHint: '' }])
    expect(owner.disposed).toEqual(expect.arrayContaining(['review', 'inspect']))
    expect([...owner.definitions.keys()]).toEqual(['test'])
    bridge.dispose()
    expect(owner.definitions.size).toBe(0)
    expect(owner.disposed).toContain('test')
  })
})
