import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeActivityEvent, ClaudeTaskInfo } from '../src/events.ts'
import { createdTaskId, deriveTeam, EMPTY_TEAM } from '../src/client/team.ts'
import { teammateTranscript, transcriptItemsForStep } from '../src/client/conversation-sidecar.ts'
import { ClaudeTeamHeaderAction } from '../src/client/ClaudeTeamHeaderAction.tsx'
import { ClaudeTeammatePanel } from '../src/client/ClaudeTeammatePanel.tsx'
import { ClaudeTranscriptToolItem } from '../src/client/ClaudeActivityNode.tsx'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, type ClaudeCodeSettingsKey } from '../src/client/locales.ts'

const t = (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>): string =>
  en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))

let ordinal = 0
function call(toolUseId: string, toolName: string, input: unknown, parentToolUseId?: string): ClaudeActivityEvent {
  return {
    turn: 1, step: 1, ordinal: ordinal++, kind: parentToolUseId === undefined ? 'tool-call' : 'subagent', phase: 'started',
    toolUseId, toolName, detail: JSON.stringify(input),
    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
  }
}
function prose(text: string, parentToolUseId?: string): ClaudeActivityEvent {
  return { turn: 1, step: 1, ordinal: ordinal++, kind: 'text', phase: 'completed', text, ...(parentToolUseId === undefined ? {} : { parentToolUseId }) }
}
function result(toolUseId: string, output: unknown, parentToolUseId?: string, isError = false): ClaudeActivityEvent {
  return {
    turn: 1, step: 1, ordinal: ordinal++, kind: parentToolUseId === undefined ? 'tool-result' : 'subagent', phase: isError ? 'failed' : 'completed',
    toolUseId, detail: typeof output === 'string' ? output : JSON.stringify(output), isError,
    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
  }
}

const teammates: ClaudeTaskInfo[] = [
  { taskId: 'tm-1', toolUseId: 'spawn-1', description: 'Review the diff', status: 'running', taskType: 'in_process_teammate', lastToolName: 'Read', usage: { toolUses: 4 }, summary: 'Parser looks fine.' },
  { taskId: 'tm-2', toolUseId: 'spawn-2', description: 'Write tests', status: 'completed', taskType: 'local_agent', subagentType: 'general-purpose', backgrounded: true },
  { taskId: 'bg-1', description: 'sleep 30', status: 'running', taskType: 'local_bash', backgrounded: true },
  { taskId: 'sa-1', toolUseId: 'spawn-3', description: 'Anonymous helper', status: 'running', taskType: 'local_agent', backgrounded: true },
]

function activities(): ClaudeActivityEvent[] {
  ordinal = 0
  return [
    call('spawn-1', 'Agent', { name: 'reviewer', description: 'Review the diff', prompt: 'Review PR 12' }),
    call('spawn-2', 'Agent', { name: 'tester', description: 'Write tests', prompt: 'Cover the parser', run_in_background: true }),
    call('spawn-3', 'Agent', { description: 'Anonymous helper', prompt: 'Look around' }),
    call('tc-1', 'TaskCreate', { subject: 'Review parser change', description: 'Look at src/parse.ts', activeForm: 'Reviewing' }),
    result('tc-1', 'Task #1 created successfully: Review parser change'),
    call('tc-2', 'TaskCreate', { subject: 'Add parser tests' }, 'spawn-2'),
    result('tc-2', { id: '2', subject: 'Add parser tests' }, 'spawn-2'),
    call('tu-1', 'TaskUpdate', { taskId: '1', status: 'in_progress', owner: 'reviewer' }),
    call('tu-2', 'TaskUpdate', { taskId: 2, status: 'completed', addBlockedBy: ['1'] }, 'spawn-2'),
    call('msg-1', 'SendMessage', { to: 'reviewer', message: 'Start with the tokenizer', summary: 'tokenizer first' }),
    call('msg-2', 'SendMessage', { to: 'lead', message: 'Tests are green' }, 'spawn-2'),
    prose('Reading the parser now.', 'spawn-1'),
    call('read-1', 'Read', { file_path: '/repo/src/parse.ts' }, 'spawn-1'),
    result('read-1', { content: 'export function parse() {}' }, 'spawn-1'),
    prose('The parser is fine.', 'spawn-1'),
    prose('Lead prose stays in the main transcript.'),
    call('tc-3', 'TaskCreate', { subject: 'Doomed' }),
    result('tc-3', 'boom', undefined, true),
  ]
}

describe('deriveTeam', () => {
  it('counts teammates and every subagent, named or not, but not background commands', () => {
    const team = deriveTeam(activities(), teammates)
    expect(team.members).toEqual([
      expect.objectContaining({ taskId: 'tm-1', name: 'reviewer', role: 'teammate', status: 'running', toolUseId: 'spawn-1', lastToolName: 'Read' }),
      expect.objectContaining({ taskId: 'tm-2', name: 'tester', status: 'completed' }),
      // An anonymous agent goes by its description.
      expect.objectContaining({ taskId: 'sa-1', name: 'Anonymous helper', status: 'running' }),
    ])
  })

  it('folds TaskCreate results and TaskUpdate patches into one shared board', () => {
    const team = deriveTeam(activities(), teammates)
    expect(team.tasks).toEqual([
      { id: '1', subject: 'Review parser change', description: 'Look at src/parse.ts', status: 'in_progress', owner: 'reviewer', blockedBy: [] },
      { id: '2', subject: 'Add parser tests', status: 'completed', blockedBy: ['1'] },
    ])
  })

  it('attributes mail to the member whose call it ran under', () => {
    const team = deriveTeam(activities(), teammates)
    expect(team.messages).toEqual([
      expect.objectContaining({ from: 'lead', to: 'reviewer', summary: 'tokenizer first', message: 'Start with the tokenizer' }),
      expect.objectContaining({ from: 'tester', to: 'lead', message: 'Tests are green' }),
    ])
  })

  it('keeps an unnamed in-process teammate under its description and a create without a result on the board', () => {
    ordinal = 0
    const team = deriveTeam(
      [call('tc-9', 'TaskCreate', { subject: 'Still pending' })],
      [{ taskId: 'tm-9', description: 'Summarize the log', status: 'running', taskType: 'in_process_teammate' }],
    )
    expect(team.members[0]).toMatchObject({ name: 'Summarize the log' })
    expect(team.tasks).toEqual([{ id: 'tc-9', subject: 'Still pending', status: 'pending', blockedBy: [] }])
  })

  it('is empty for a session without a team', () => {
    ordinal = 0
    expect(deriveTeam([call('b-1', 'Bash', { command: 'ls' })], [teammates[2]!])).toBe(EMPTY_TEAM)
  })

  it('folds one teammate\'s prose and tools into transcript items and keeps them out of the lead step', () => {
    const events = activities()
    expect(teammateTranscript(events, 'tm-1', 'spawn-1')).toEqual([
      { kind: 'text', ordinal: expect.any(Number), text: 'Reading the parser now.' },
      { kind: 'tools', ordinal: expect.any(Number), tools: [expect.objectContaining({ toolUseId: 'read-1', toolName: 'Read', phase: 'completed' })] },
      { kind: 'text', ordinal: expect.any(Number), text: 'The parser is fine.' },
    ])
    const lead = transcriptItemsForStep(events, 1, 1)
    expect(lead.filter(item => item.kind === 'text').map(item => item.kind === 'text' ? item.text : '')).toEqual(['Lead prose stays in the main transcript.'])
  })

  it('reads the created task id from prose or structure', () => {
    expect(createdTaskId('Task #12 created successfully: x')).toBe('12')
    expect(createdTaskId(JSON.stringify({ task: { id: 7 } }))).toBe('7')
    expect(createdTaskId(JSON.stringify({ id: 'abc' }))).toBe('abc')
    expect(createdTaskId('nothing here')).toBeUndefined()
  })
})

function hook(owned: boolean, tasks: readonly ClaudeTaskInfo[], events: readonly ClaudeActivityEvent[]) {
  const snapshot: ClaudeClientProjection = { ...EMPTY_CLAUDE_PROJECTION, owned, activities: events, tasks: { tasks } }
  return <S,>(selector: (value: ClaudeClientProjection) => S): S => selector(snapshot)
}

describe('ClaudeTeamHeaderAction', () => {
  it('renders nothing without a team and a counted trigger with one', () => {
    expect(renderToStaticMarkup(<ClaudeTeamHeaderAction t={t} sessionId="s" openTeammate={vi.fn()} useClaudeProjection={hook(true, [teammates[2]!], [])} />)).toBe('')
    expect(renderToStaticMarkup(<ClaudeTeamHeaderAction t={t} sessionId="s" openTeammate={vi.fn()} useClaudeProjection={hook(false, teammates, activities())} />)).toBe('')
    const markup = renderToStaticMarkup(<ClaudeTeamHeaderAction t={t} sessionId="s" openTeammate={vi.fn()} useClaudeProjection={hook(true, teammates, activities())} />)
    expect(markup).toContain('aria-label="Agent Team"')
    expect(markup).toContain('aria-expanded="false"')
    // Lead plus three subagents; the background command is not a member.
    expect(markup).toContain('<span class="dsh-claude-team-count">4</span>')
    expect(markup).toContain('dsh-claude-team-trigger-label')
  })
})

describe('ClaudeTeammatePanel', () => {
  it('draws the teammate as a conversation: brief, its prose and tools, then its report', () => {
    const markup = renderToStaticMarkup(<ClaudeTeammatePanel t={t} closeDetails={vi.fn()} taskId="tm-1" useClaudeProjection={hook(true, teammates, activities())} />)
    expect(markup).toContain('>reviewer<')
    expect(markup).toContain('Running')
    expect(markup).toContain('4 tool calls')
    // The Lead's brief as the opening turn, the report as the closing answer.
    expect(markup).toContain('Review PR 12')
    expect(markup).toContain('Parser looks fine.')
    // Its own prose and tool cards in between, nothing from other members.
    expect(markup).toContain('Reading the parser now.')
    expect(markup).toContain('The parser is fine.')
    // Tool cards fold behind the group row, as they do in the chat.
    expect(markup).toContain('dsh-claude-tool-group-native')
    expect(markup).toContain('Used 1 tool')
    expect(markup).not.toContain('Tests are green')
    expect(markup).not.toContain('Lead prose stays')
    expect(markup).toContain('aria-label="Close teammate panel"')
  })

  it('says so when the teammate left the board', () => {
    const markup = renderToStaticMarkup(<ClaudeTeammatePanel t={t} closeDetails={vi.fn()} taskId="nope" useClaudeProjection={hook(true, teammates, activities())} />)
    expect(markup).toContain('no longer on the task board')
  })
})

describe('ClaudeTranscriptToolItem background control', () => {
  const tool = (overrides: Record<string, unknown>) => ({ toolUseId: 'call-1', toolName: 'Bash', description: 'Run deploy', subcalls: [], phase: 'started', ...overrides } as never)
  const onBackground = async () => 'moved'
  it('offers to move only a running Bash call, and only where the chat wired the control', () => {
    expect(renderToStaticMarkup(<ClaudeTranscriptToolItem tool={tool({})} t={t} onBackground={onBackground} />)).toContain('aria-label="Move to background"')
    expect(renderToStaticMarkup(<ClaudeTranscriptToolItem tool={tool({ phase: 'completed' })} t={t} onBackground={onBackground} />)).not.toContain('Move to background')
    expect(renderToStaticMarkup(<ClaudeTranscriptToolItem tool={tool({ toolName: 'Read' })} t={t} onBackground={onBackground} />)).not.toContain('Move to background')
    expect(renderToStaticMarkup(<ClaudeTranscriptToolItem tool={tool({})} t={t} />)).not.toContain('Move to background')
  })
})
