import { describe, expect, it } from 'vitest'
import {
  CLAUDE_PERMISSION_MODES,
  claudePermissionMode,
  isClaudePermissionMode,
  sandboxModeOf,
} from '../src/permission-mode.ts'

const sandbox = (mode: string) => ({ type: 'sandbox/mode', data: { mode } })

describe('Claude permission mode fold', () => {
  it('offers every Claude Code mode the selector lists, tightest first', () => {
    expect(CLAUDE_PERMISSION_MODES).toEqual(['plan', 'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'])
    expect(isClaudePermissionMode('acceptEdits')).toBe(true)
    expect(isClaudePermissionMode('auto')).toBe(true)
    expect(isClaudePermissionMode('yolo')).toBe(false)
    expect(isClaudePermissionMode(undefined)).toBe(false)
  })

  it('runs the chosen mode while the session sits on the sandbox it needs', () => {
    expect(claudePermissionMode([sandbox('workspace-write')], 'default')).toBe('default')
    expect(claudePermissionMode([sandbox('workspace-write')], 'dontAsk')).toBe('dontAsk')
    expect(claudePermissionMode([sandbox('workspace-write')], 'auto')).toBe('auto')
    expect(claudePermissionMode([sandbox('read-only')], 'plan')).toBe('plan')
    expect(claudePermissionMode([sandbox('danger-full-access')], 'bypassPermissions')).toBe('bypassPermissions')
    // No sandbox event at all is a session the Host has not pinned yet; the
    // choice is the only fact there is.
    expect(claudePermissionMode([], 'acceptEdits')).toBe('acceptEdits')
  })

  it('lets a sandbox switched natively after the choice win', () => {
    // /permission read-only after choosing acceptEdits: the sandbox no longer
    // carries that mode, so the session runs what the sandbox means.
    expect(claudePermissionMode([sandbox('workspace-write'), sandbox('read-only')], 'acceptEdits')).toBe('plan')
    expect(claudePermissionMode([sandbox('danger-full-access')], 'plan')).toBe('bypassPermissions')
  })

  it('maps a session that never chose onto the sandbox, and fails safe to plan', () => {
    expect(claudePermissionMode([sandbox('workspace-write')])).toBe('acceptEdits')
    expect(claudePermissionMode([])).toBe('plan')
    expect(claudePermissionMode([sandbox('workspace-write'), sandbox('invalid')])).toBe('plan')
    // An unreadable newest sandbox event is not a match for anything.
    expect(claudePermissionMode([sandbox('invalid')], 'default')).toBe('plan')
  })

  it('reads the newest sandbox event and tells missing from unreadable', () => {
    expect(sandboxModeOf([])).toBeUndefined()
    expect(sandboxModeOf([sandbox('read-only'), sandbox('nope')])).toBeNull()
    expect(sandboxModeOf([sandbox('nope'), sandbox('read-only')])).toBe('read-only')
  })
})
