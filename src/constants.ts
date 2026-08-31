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
export const SDK_VERSION = '0.3.247'
export const CLAUDE_DOCTOR_PATH = '/plugins/dsh-claude/doctor'
export const CLAUDE_CLIENT_DIAGNOSTICS_PATH = '/plugins/dsh-claude/client-diagnostics'
export const CLAUDE_UPDATE_CHECK_PATH = '/plugins/dsh-claude/update/check'
export const CLAUDE_USAGE_PATH = '/plugins/dsh-claude/usage'
export const CLAUDE_UPDATE_PATH = '/plugins/dsh-claude/update'
export const CLAUDE_PROJECTION_PATH = '/plugins/dsh-claude/projection'
export const CLAUDE_GLOBAL_SETTINGS_PATH = '/plugins/dsh-claude/settings/global'
export const CLAUDE_REPOSITORY_SETUP_PATH = '/plugins/dsh-claude/repository/setup'
export const CLAUDE_REPOSITORY_ACTION_PATH = '/plugins/dsh-claude/repository/action'
export const CLAUDE_REVIEW_COMMENT_PATH = '/plugins/dsh-claude/review-comments'
export const CLAUDE_REPOSITORY_FEEDBACK_PATH = '/plugins/dsh-claude/repository/feedback'
export const CLAUDE_REPOSITORY_STATUS_PATH = '/plugins/dsh-claude/repository/status'
export const CLAUDE_REPOSITORY_FILE_PATH = '/plugins/dsh-claude/repository/file'
export const CLAUDE_JIRA_PATH = '/plugins/dsh-claude/jira'
export const CLAUDE_ASK_PATH = '/plugins/dsh-claude/ask'
export const CLAUDE_EDITOR_OPEN_PATH = '/plugins/dsh-claude/editor/open'
export const CLAUDE_REWIND_PATH = '/plugins/dsh-claude/rewind'

/** Which renderer draws Claude's visible output.
 *
 *  'plugin' keeps the sidecar-backed transcript this package owns (interleaved
 *  prose, grouped tool cards, activity rows). 'native' hands the same turn to
 *  DSH's own conversation renderer: prose streams as ordinary assistant text
 *  blocks, thinking as reasoning blocks, and root Claude tools are mirrored
 *  into the durable `tool/call`/`tool/result` channel so the Host's tool
 *  presentation pipeline draws them exactly like DSH-executed calls. */
export type ClaudeRenderMode = 'plugin' | 'native'
export const CLAUDE_RENDER_MODES = ['plugin', 'native'] as const
export const DEFAULT_CLAUDE_RENDER_MODE: ClaudeRenderMode = 'plugin'

export function isClaudeRenderMode(value: unknown): value is ClaudeRenderMode {
  return value === 'plugin' || value === 'native'
}
