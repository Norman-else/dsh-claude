import { describe, expect, it } from 'vitest'
import type { ClaudeActivityEvent } from '../src/events.ts'
import { taskTools } from '../src/client/conversation-sidecar.ts'

let ordinal = 0
function activity(event: Partial<ClaudeActivityEvent>): ClaudeActivityEvent {
  return { turn: 1, step: 1, ordinal: ordinal++, kind: 'subagent', ...event } as ClaudeActivityEvent
}

/** A task's own lifecycle ping, which is where its dispatching call id lives. */
function ping(taskId: string, toolUseId: string, subtype = 'task_progress'): ClaudeActivityEvent {
  return activity({ kind: 'subagent', taskId, detail: JSON.stringify({ type: 'system', subtype, task_id: taskId, tool_use_id: toolUseId }) })
}

describe('taskTools', () => {
  it('pairs the tools a subagent ran under the call that dispatched it', () => {
    const activities = [
      ping('task-1', 'parent-1', 'task_started'),
      activity({ parentToolUseId: 'parent-1', toolUseId: 'call-1', toolName: 'Bash', phase: 'started', detail: JSON.stringify({ command: 'ls -la', description: 'List files' }) }),
      activity({ parentToolUseId: 'parent-1', toolUseId: 'call-1', phase: 'completed', detail: JSON.stringify({ stdout: 'a.txt' }) }),
      // Another task's work must not leak into this card.
      activity({ parentToolUseId: 'parent-2', toolUseId: 'call-9', toolName: 'Read', phase: 'started', detail: '{}' }),
    ]

    expect(taskTools(activities, 'task-1')).toEqual([
      expect.objectContaining({
        toolUseId: 'call-1',
        toolName: 'Bash',
        description: 'List files',
        phase: 'completed',
        input: JSON.stringify({ command: 'ls -la', description: 'List files' }),
        output: JSON.stringify({ stdout: 'a.txt' }),
      }),
    ])
  })

  it('describes a failed tool as the failure it was', () => {
    const activities = [
      ping('task-1', 'parent-1'),
      activity({ parentToolUseId: 'parent-1', toolUseId: 'call-1', toolName: 'Read', phase: 'started', detail: JSON.stringify({ file_path: '/tmp/x' }) }),
      activity({ parentToolUseId: 'parent-1', toolUseId: 'call-1', phase: 'failed', isError: true, detail: 'ENOENT' }),
    ]

    expect(taskTools(activities, 'task-1')[0]).toMatchObject({
      description: 'Failed to read /tmp/x',
      isError: true,
      phase: 'failed',
    })
  })

  it('falls back to the call the task IS when it ran no tools of its own', () => {
    // A backgrounded Bash task has no children: the command it is running is
    // the root call the ping points at.
    const activities = [
      ping('task-1', 'root-1'),
      activity({ kind: 'tool-call', toolUseId: 'root-1', toolName: 'Bash', phase: 'started', detail: JSON.stringify({ command: 'pnpm check' }) }),
      activity({ kind: 'tool-result', toolUseId: 'root-1', phase: 'completed', detail: JSON.stringify({ stdout: 'ok' }) }),
    ]

    expect(taskTools(activities, 'task-1')).toEqual([
      expect.objectContaining({ toolUseId: 'root-1', toolName: 'Bash', description: 'Ran pnpm check', phase: 'completed' }),
    ])
  })

  it('has nothing to show for a task whose pings carry no call id', () => {
    expect(taskTools([activity({ kind: 'subagent', taskId: 'task-1', detail: '{"subtype":"task_started"}' })], 'task-1')).toEqual([])
    expect(taskTools([], 'task-1')).toEqual([])
  })

  it('keeps a tool still running visible rather than waiting for its result', () => {
    const activities = [
      ping('task-1', 'parent-1'),
      activity({ parentToolUseId: 'parent-1', toolUseId: 'call-1', toolName: 'Bash', phase: 'started', detail: JSON.stringify({ command: 'sleep 30' }) }),
    ]

    const tool = taskTools(activities, 'task-1')[0]
    expect(tool).toMatchObject({ phase: 'started' })
    expect(tool?.output).toBeUndefined()
  })
})
