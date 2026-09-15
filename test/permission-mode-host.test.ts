import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { alignSessionWithDefault, applyHostPreset, type HostPermissionPresetService } from '../src/permission-mode-host.ts'

function agentWith(sandbox?: string): Agent {
  const events = sandbox === undefined ? [] : [{ type: 'sandbox/mode', data: { mode: sandbox } }]
  return { id: 'session', session: { snapshotEvents: () => events } } as unknown as Agent
}

function presets(names: readonly string[]): HostPermissionPresetService & { apply: ReturnType<typeof vi.fn> } {
  return {
    names,
    apply: vi.fn((_session: unknown, _name: string, setApproval: (policy: string) => void) => { setApproval('ask') }),
  }
}

describe('Host preset hand-off', () => {
  it('puts the Host on the preset named after the sandbox and relays the policy to the live agent', () => {
    const service = presets(['read-only', 'workspace-write', 'danger-full-access'])
    const setPolicy = vi.fn()
    const agent = agentWith('danger-full-access')
    expect(applyHostPreset({ presets: () => service, setPolicy }, agent, 'workspace-write')).toBe(true)
    expect(service.apply).toHaveBeenCalledWith(agent.session, 'workspace-write', expect.any(Function))
    expect(setPolicy).toHaveBeenCalledWith(agent, 'ask')
  })

  it('declines without a preset service or the named entry, and touches nothing', () => {
    const setPolicy = vi.fn()
    expect(applyHostPreset({ presets: () => undefined, setPolicy }, agentWith(), 'workspace-write')).toBe(false)
    const service = presets(['workspace-write'])
    expect(applyHostPreset({ presets: () => service, setPolicy }, agentWith(), 'read-only')).toBe(false)
    expect(service.apply).not.toHaveBeenCalled()
    expect(setPolicy).not.toHaveBeenCalled()
  })
})

describe('aligning a new session with the default mode', () => {
  it('moves a session that inherited another sandbox onto the one its default needs', () => {
    // The Host's default preset was full access; the plugin's default is auto,
    // which rides on workspace-write. Left alone the fold would report bypass.
    const service = presets(['read-only', 'workspace-write', 'danger-full-access'])
    expect(alignSessionWithDefault({ presets: () => service, setPolicy: vi.fn() }, agentWith('danger-full-access'), undefined, 'auto')).toBe('workspace-write')
    expect(service.apply).toHaveBeenCalledWith(expect.anything(), 'workspace-write', expect.any(Function))
  })

  it('leaves a session alone when it already sits on that sandbox or chose its own mode', () => {
    const service = presets(['read-only', 'workspace-write', 'danger-full-access'])
    const access = { presets: () => service, setPolicy: vi.fn() }
    expect(alignSessionWithDefault(access, agentWith('workspace-write'), undefined, 'auto')).toBeUndefined()
    expect(alignSessionWithDefault(access, agentWith('danger-full-access'), 'bypassPermissions', 'auto')).toBeUndefined()
    expect(service.apply).not.toHaveBeenCalled()
  })

  it('reports nothing moved when the Host cannot take the preset', () => {
    expect(alignSessionWithDefault({ presets: () => undefined, setPolicy: vi.fn() }, agentWith('danger-full-access'), undefined, 'plan')).toBeUndefined()
  })
})
