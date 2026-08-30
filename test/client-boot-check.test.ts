import { describe, expect, it } from 'vitest'
import { claudeBootCheckFindings, CLAUDE_REQUIRED_CSS_VARIABLES } from '../src/client/boot-check.ts'

const services = ['slots', 'uiConversation'] as const

function input(overrides: Partial<Parameters<typeof claudeBootCheckFindings>[0]> = {}) {
  return {
    services,
    resolve: (name: string) => (services.includes(name as never) ? {} : undefined),
    cssVariables: ['--dsh-composer-card-max-width'],
    readCssVariable: () => '1024px',
    ...overrides,
  }
}

describe('Claude client boot check', () => {
  it('reports nothing when every dependency resolves', () => {
    expect(claudeBootCheckFindings(input())).toEqual([])
  })

  it('names each declared service the Host does not provide', () => {
    const findings = claudeBootCheckFindings(input({
      resolve: (name: string) => (name === 'slots' ? {} : undefined),
    }))
    expect(findings).toEqual(['service "uiConversation" is declared in inject but the Host does not provide it'])
  })

  // A renamed custom property is the one drift that cannot surface on its own:
  // var(--x, fallback) cannot tell "absent" from "this value", so the styles
  // silently freeze at the fallback instead of tracking the Host.
  it('names each CSS custom property the Host no longer defines', () => {
    const findings = claudeBootCheckFindings(input({ readCssVariable: () => '' }))
    expect(findings).toEqual([
      'CSS custom property "--dsh-composer-card-max-width" is not defined by the Host; styles reading it are stuck on their fallback',
    ])
  })

  it('treats a whitespace-only property value as undefined', () => {
    expect(claudeBootCheckFindings(input({ readCssVariable: () => '   ' }))).toHaveLength(1)
  })

  it('ships the Host-owned layout property the composer bars track', () => {
    expect(CLAUDE_REQUIRED_CSS_VARIABLES).toContain('--dsh-composer-card-max-width')
  })
})
