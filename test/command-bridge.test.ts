import { describe, expect, it } from 'vitest'
import { projectClaudeCommands } from '../src/command-bridge.ts'

function target(reserved: string[] = []) {
  return { list: () => reserved.map(name => ({ name })) }
}

const catalog = [{
  name: 'review',
  description: 'Review current changes',
  argumentHint: '<path>',
  aliases: ['inspect'],
}]

describe('Claude command projection', () => {
  it('projects native command names and aliases with their argument hints', () => {
    expect(projectClaudeCommands(catalog, target())).toEqual([
      { publicName: 'review', claudeName: 'review', description: 'Review current changes', hint: '<path>', prefixed: false },
      { publicName: 'inspect', claudeName: 'inspect', description: 'Review current changes', hint: '<path>', prefixed: false },
    ])
  })

  it('keeps DSH and client contribution names authoritative', () => {
    expect(projectClaudeCommands([
      { name: 'compact', description: 'Claude compact', argumentHint: '' },
      { name: 'model', description: 'Claude model picker', argumentHint: '' },
    ], target(['compact']))).toEqual([
      { publicName: 'claude-compact', claudeName: 'compact', description: 'Claude compact', prefixed: true },
      { publicName: 'claude-model', claudeName: 'model', description: 'Claude model picker', prefixed: true },
    ])
  })

  it('drops invalid names and skips a second prefixed collision', () => {
    expect(projectClaudeCommands([
      { name: 'Bad Name', description: 'invalid', argumentHint: '' },
      { name: 'bad', description: 'collides twice', argumentHint: '' },
    ], target(['bad', 'claude-bad']))).toEqual([])
  })

  it('projects plugin-qualified skills by short name while retaining the exact Claude name', () => {
    expect(projectClaudeCommands([{
      name: 'awesome-skills:ci-deploy',
      description: 'Deploy through CI',
      argumentHint: '<env>',
    }], target())).toEqual([
      {
        publicName: 'ci-deploy',
        claudeName: 'awesome-skills:ci-deploy',
        description: 'Deploy through CI',
        hint: '<env>',
        prefixed: false,
      },
    ])
  })
})
