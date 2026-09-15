/** Driving the Host's own access knobs from a Claude permission mode.
 *
 *  The Host's preset service bundles a sandbox mode with an approval policy
 *  under one name, and its default table names each preset after its sandbox
 *  mode. This plugin's modes are carried on those presets (permission-mode.ts),
 *  so putting a session on a mode means putting the Host on that preset. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SANDBOX_BY_CLAUDE_MODE, sandboxModeOf, type ClaudePermissionMode, type DshSandboxMode } from './permission-mode.ts'

/** The Host's preset service, when the profile mounts one. Not part of this
 *  plugin's typed host surface; read through an untyped escape hatch so a
 *  Host without it leaves Claude to enforce the mode alone. */
export interface HostPermissionPresetService {
  readonly names: readonly string[]
  apply(session: Agent['session'], name: string, setApproval: (policy: string) => void): void
}

export interface HostPresetAccess {
  /** Resolved per call: the service can mount after this plugin does. */
  presets: () => HostPermissionPresetService | undefined
  /** The command handler's own live-session path: the approval service hears
   *  the policy for the running agent, not just the log. */
  setPolicy: (agent: Agent, policy: string) => void
}

/** Put the Host on the preset named after `sandbox`. Answers whether it took:
 *  a Host with no preset service, or whose table lacks that entry, leaves
 *  Claude to enforce the mode on its own. */
export function applyHostPreset(access: HostPresetAccess, agent: Agent, sandbox: DshSandboxMode): boolean {
  const presets = access.presets()
  if (presets === undefined || !presets.names.includes(sandbox)) return false
  presets.apply(agent.session, sandbox, policy => { access.setPolicy(agent, policy) })
  return true
}

/** Put a session that has not chosen a mode on the sandbox its default needs.
 *
 *  The fold in permission-mode.ts lets the sandbox win over a mode it cannot
 *  carry, which is right for a sandbox the user switched deliberately -- and
 *  wrong for the one a fresh session merely inherited from the Host's default
 *  preset, where it would quietly turn a configured `auto` into whatever that
 *  preset means. So a new Claude session is moved onto its default's sandbox
 *  once, at creation; a session that already chose its own mode is left alone.
 *  @returns the sandbox the Host was put on, or undefined when nothing moved. */
export function alignSessionWithDefault(
  access: HostPresetAccess,
  agent: Agent,
  chosen: ClaudePermissionMode | undefined,
  defaultMode: ClaudePermissionMode,
): DshSandboxMode | undefined {
  if (chosen !== undefined) return undefined
  const wanted = SANDBOX_BY_CLAUDE_MODE[defaultMode]
  if (sandboxModeOf(agent.session.snapshotEvents()) === wanted) return undefined
  return applyHostPreset(access, agent, wanted) ? wanted : undefined
}
