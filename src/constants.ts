export const CLAUDE_CODE_PROVIDER = 'claude'
export const CLAUDE_CODE_PRESET_ID = 'claude'
export const LEGACY_CLAUDE_CODE_PROVIDER = 'claude-code-cli'
export const LEGACY_CLAUDE_CODE_PRESET_ID = 'claude-code-cli'
export const CLAUDE_CODE_PROVIDER_IDS = [CLAUDE_CODE_PROVIDER, LEGACY_CLAUDE_CODE_PROVIDER] as const
export function isClaudePresetId(value: string | undefined): boolean {
  return value === CLAUDE_CODE_PRESET_ID || value === LEGACY_CLAUDE_CODE_PRESET_ID
}
export function isClaudeProvider(value: string | undefined): boolean {
  return value === CLAUDE_CODE_PROVIDER || value === LEGACY_CLAUDE_CODE_PROVIDER
}
export const CLAUDE_SESSION_BOUND_EVENT = 'claude-code/session-bound'
export const CLAUDE_ACTIVITY_EVENT = 'claude-code/activity'
export const CLAUDE_CONTEXT_USAGE_EVENT = 'claude-code/context-usage'
export const CLAUDE_TASKS_EVENT = 'claude-code/tasks'
/** Claude's subagent dispatch tools; rendered as plugin-owned group cards
 *  gathering subagent activity instead of native tool cards. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent'])
export const SDK_VERSION = '0.3.233'
export const CLAUDE_DOCTOR_PATH = '/plugins/dsh-claude/doctor'
export const CLAUDE_PROJECTION_PATH = '/plugins/dsh-claude/projection'
