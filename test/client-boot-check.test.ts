import { describe, expect, it } from 'vitest'
import {
  CLAUDE_COMPOSER_BAR_ATTRIBUTE,
  CLAUDE_SCOPED_CSS_VARIABLES,
  claudeBootCheckFindings,
  claudeScopedCssFindings,
} from '../src/client/boot-check.ts'

const services = ['slots', 'uiConversation'] as const

describe('Claude client boot check', () => {
  it('reports nothing when every declared service resolves with the methods it is called on', () => {
    const findings = claudeBootCheckFindings({ services, resolve: () => ({ binding: () => undefined }) })
    expect(findings).toEqual([])
  })

  // The drift that broke the worktree flow: the service still resolved, so the
  // feature registered itself and only failed once a user ran it.
  it('names a method a resolving service no longer provides', () => {
    const findings = claudeBootCheckFindings({ services, resolve: () => ({}) })
    expect(findings).toEqual(['service "uiConversation" no longer provides binding(); the features calling it are broken'])
  })

  it('names each declared service the Host does not provide', () => {
    const findings = claudeBootCheckFindings({
      services,
      resolve: (name: string) => (name === 'slots' ? {} : undefined),
    })
    expect(findings).toEqual(['service "uiConversation" is declared in inject but the Host does not provide it'])
  })
})

describe('Claude scoped CSS check', () => {
  it('reports nothing while the property is visible', () => {
    expect(claudeScopedCssFindings(() => 'calc(1043px + 32px)')).toEqual([])
  })

  // A renamed custom property is the one drift that cannot surface on its own:
  // var(--x, fallback) cannot tell "absent" from "this value", so the styles
  // silently freeze at the fallback instead of tracking the Host.
  it('names each property the measured element cannot see', () => {
    expect(claudeScopedCssFindings(() => '', ['--dsh-composer-card-max-width'])).toEqual([
      'CSS custom property "--dsh-composer-card-max-width" is not visible to the composer bar; styles reading it are stuck on their fallback',
    ])
  })

  it('treats a whitespace-only value as absent', () => {
    expect(claudeScopedCssFindings(() => '   ', ['--x'])).toHaveLength(1)
  })

  // The Host publishes these onto the composer subtree, never onto :root, so a
  // probe above that subtree reports every one of them missing forever.
  it('ships the resizable composer property and the bar marker it is read from', () => {
    expect(CLAUDE_SCOPED_CSS_VARIABLES).toContain('--dsh-composer-card-max-width')
    expect(CLAUDE_COMPOSER_BAR_ATTRIBUTE).toBe('data-dsh-claude-composer-bar')
  })
})
