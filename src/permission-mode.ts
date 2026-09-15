/** Claude Code's own permission modes as the session's access control.
 *
 *  DSH's access selector offers three sandbox modes, each bundled with an
 *  approval policy, and neither the table nor the selector is something a
 *  plugin can extend. Claude Code has more modes than that, and two of them
 *  (`default`, `acceptEdits`) sit on the same DSH sandbox mode, so the
 *  session's Claude mode is kept here, by this plugin, and the DSH knobs are
 *  driven from it rather than the other way round.
 *
 *  The fold still honours DSH: a sandbox mode switched natively (the
 *  `/permission` command, another client) after the plugin's choice no
 *  longer matches what that choice needs, and the sandbox wins. */
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/** Every mode this plugin offers is one Claude Code has; the SDK's union is
 *  the authority, and this line fails the build the day the two drift. */
const _modesAreClaudeCodes: readonly PermissionMode[] = [] as readonly ClaudePermissionModeCheck[]
type ClaudePermissionModeCheck = 'plan' | 'default' | 'acceptEdits' | 'dontAsk' | 'auto' | 'bypassPermissions'
void _modesAreClaudeCodes

/** Every mode the selector offers, in the order it lists them: tightest
 *  first. `auto` hands each ask to Claude Code's own classifier and is a
 *  per-model capability, so the selector greys it out where the catalog says
 *  the session's model lacks it. */
export const CLAUDE_PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'] as const
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number]

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value)
}

export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** The DSH sandbox mode a Claude mode is carried on. The Host's preset table
 *  names its presets after these modes, so the same string selects the preset. */
export const SANDBOX_BY_CLAUDE_MODE: Readonly<Record<ClaudePermissionMode, DshSandboxMode>> = {
  plan: 'read-only',
  default: 'workspace-write',
  acceptEdits: 'workspace-write',
  dontAsk: 'workspace-write',
  auto: 'workspace-write',
  bypassPermissions: 'danger-full-access',
}

/** The closest Claude mode for a sandbox mode chosen without this plugin's
 *  selector: what the session runs under until the selector is used. */
export const CLAUDE_MODE_BY_SANDBOX: Readonly<Record<DshSandboxMode, ClaudePermissionMode>> = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'bypassPermissions',
}

function isSandboxMode(value: unknown): value is DshSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

/** The session's effective sandbox mode: the newest `sandbox/mode` event,
 *  undefined when there is none, and `null` for a newest event this plugin
 *  cannot read (which fails safe rather than falling back to an older one). */
export function sandboxModeOf(events: readonly { type: string; data: unknown }[]): DshSandboxMode | null | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'sandbox/mode') continue
    const mode = (event.data as { mode?: unknown }).mode
    return isSandboxMode(mode) ? mode : null
  }
  return undefined
}

/** The Claude mode a session runs its next turn under.
 *
 *  `chosen` is what the plugin's selector recorded; it stands for as long as
 *  the session's sandbox mode is the one it needs. A session that never chose
 *  runs the sandbox's closest mode, and one with no sandbox at all, or an
 *  unreadable one, runs `plan`: the mode that can do the least. */
export function claudePermissionMode(
  events: readonly { type: string; data: unknown }[],
  chosen?: ClaudePermissionMode,
): ClaudePermissionMode {
  const sandbox = sandboxModeOf(events)
  if (chosen !== undefined && (sandbox === undefined || sandbox === SANDBOX_BY_CLAUDE_MODE[chosen])) return chosen
  return sandbox === undefined || sandbox === null ? 'plan' : CLAUDE_MODE_BY_SANDBOX[sandbox]
}

/** Which access control a Claude session shows and obeys: the Host's own
 *  three-preset selector with the sandbox mapping alone (`native`), or this
 *  plugin's selector over Claude Code's modes with the default mode and the
 *  creation-time alignment (`plugin`). */
export const CLAUDE_PERMISSION_SELECTORS = ['plugin', 'native'] as const
export type ClaudePermissionSelector = typeof CLAUDE_PERMISSION_SELECTORS[number]
export const DEFAULT_CLAUDE_PERMISSION_SELECTOR: ClaudePermissionSelector = 'plugin'

export function isClaudePermissionSelector(value: unknown): value is ClaudePermissionSelector {
  return value === 'plugin' || value === 'native'
}

/** What the client shows for one session. */
export interface ClaudePermissionModeView {
  readonly mode: ClaudePermissionMode
  /** A turn is in flight; the mode it started under is the mode it keeps. */
  readonly locked: boolean
  /** Whether the session's model can run `auto`, when the catalog knows the
   *  model; absent while it does not, and the selector offers the mode. */
  readonly autoSupported?: boolean
}
