import { describe, expect, it } from 'vitest'
import { ClaudeTaskBoard, carriedTodos, createdTaskId, todosFromTodoWrite } from '../src/todo-bridge.ts'

describe('Claude to-do bridge', () => {
  it('reads a TodoWrite list, dropping malformed rows and repeated content', () => {
    expect(todosFromTodoWrite({ todos: [
      { content: ' Read the parser ', status: 'completed', activeForm: 'Reading' },
      { content: 'Fix the bug', status: 'in_progress' },
      { content: 'Fix the bug', status: 'pending' },
      { content: '', status: 'pending' },
      { content: 'Unknown status', status: 'blocked' },
    ] })).toEqual([
      { content: 'Read the parser', status: 'completed' },
      { content: 'Fix the bug', status: 'in_progress' },
    ])
    expect(todosFromTodoWrite({ nope: true })).toBeUndefined()
  })

  it('folds TaskCreate results and TaskUpdate patches into one board', () => {
    const board = new ClaudeTaskBoard()
    expect(board.call('TaskCreate', 'c1', { subject: 'Write tests' })).toBe(false)
    expect(board.result('c1', [{ task: { id: '1' } }, 'Task #1 created'], false)).toBe(true)
    board.call('TaskCreate', 'c2', { subject: 'Ship it' })
    board.result('c2', [undefined, 'Task #2 created successfully'], false)
    board.call('TaskCreate', 'c3', { subject: 'Doomed' })
    expect(board.result('c3', ['boom'], true)).toBe(false)
    expect(board.call('TaskUpdate', 'u1', { taskId: '1', status: 'in_progress' })).toBe(true)
    expect(board.call('TaskUpdate', 'u2', { taskId: '1', status: 'in_progress' })).toBe(false)
    board.call('TaskUpdate', 'u3', { taskId: 9, status: 'completed' })
    expect(board.todos()).toEqual([
      { content: 'Write tests', status: 'in_progress' },
      { content: 'Ship it', status: 'pending' },
      { content: '#9', status: 'completed' },
    ])
    expect(board.call('TaskUpdate', 'u4', { taskId: '2', status: 'deleted' })).toBe(true)
    expect(board.todos().map(item => item.content)).toEqual(['Write tests', '#9'])
  })

  it('carries the latest list over only while some of it is open', () => {
    const write = (todos: unknown) => ({ type: 'todo/write', data: { todos } })
    expect(carriedTodos([write([{ content: 'a', status: 'completed' }]), { type: 'turn/start', data: {} }])).toBeUndefined()
    expect(carriedTodos([write([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]), { type: 'turn/start', data: {} }]))
      .toEqual([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }])
    expect(carriedTodos([{ type: 'turn/start', data: {} }])).toBeUndefined()
  })

  it('reads a created task id from structure or prose', () => {
    expect(createdTaskId('Task #12 created successfully: x')).toBe('12')
    expect(createdTaskId({ task: { id: 7 } })).toBe('7')
    expect(createdTaskId(JSON.stringify({ id: 'abc' }))).toBe('abc')
    expect(createdTaskId('nothing here')).toBeUndefined()
  })
})
