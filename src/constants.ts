export const CLAUDE_CODE_PROVIDER = 'claude'
export const CLAUDE_CODE_PRESET_ID = 'claude'
export const CLAUDE_CODE_PROVIDER_IDS = [CLAUDE_CODE_PROVIDER] as const
export const CLAUDE_SESSION_BOUND_EVENT = 'claude-code/session-bound'
export const CLAUDE_ACTIVITY_EVENT = 'claude-code/activity'
export const CLAUDE_CONTEXT_USAGE_EVENT = 'claude-code/context-usage'
export const CLAUDE_TASKS_EVENT = 'claude-code/tasks'
/** Claude's subagent dispatch tools; rendered as plugin-owned group cards
 *  gathering subagent activity instead of native tool cards. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent'])
export const SDK_VERSION = '0.3.233'
export const CLAUDE_DOCTOR_PATH = '/plugins/dsh-claude/doctor'
export const CLAUDE_UPDATE_CHECK_PATH = '/plugins/dsh-claude/update/check'
export const CLAUDE_UPDATE_PATH = '/plugins/dsh-claude/update'
export const CLAUDE_PROJECTION_PATH = '/plugins/dsh-claude/projection'
export const CLAUDE_GLOBAL_SETTINGS_PATH = '/plugins/dsh-claude/settings/global'
export const CLAUDE_REPOSITORY_SETUP_PATH = '/plugins/dsh-claude/repository/setup'
export const CLAUDE_REPOSITORY_ACTION_PATH = '/plugins/dsh-claude/repository/action'
